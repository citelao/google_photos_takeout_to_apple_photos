import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { distance } from "./numbers";
import { execAsync } from "./exec";
import { getPhotosAlbums, findPhotoInPhotos, findOrCreateAlbum, addPhotosToAlbumIfMissing, getAlbumPhotosCount, getInfoForPhotoIds, importPhotosToAlbumChunked } from "./photos_app";



const DO_ACTIONS = true;
const WHAT_IF = false;





interface ExifToolOutput {
    SourceFile: string;
    // ...many other things...
    MakerNotes: {
        ContentIdentifier: string | undefined;
    } | undefined,
    Composite: {
        GPSLatitude: string | number | undefined;
        GPSLongitude: string | number | undefined;

        // File creation
        SubSecCreateDate: number | undefined;

        // Image taken
        SubSecDateTimeOriginal: number | undefined;
    }
}
async function getExifToolData(path: string): Promise<ExifToolOutput> {
    const PRECISION = 6;
    const result = await execAsync(`exiftool -g -json -d "%s" -c "%+.${PRECISION}f" "${path}"`);
    const json = JSON.parse(result.stdout)[0];
    // console.log(json);
    return json;
}

async function getExifToolDataForDirectory(dirPath: string): Promise<[ExifToolOutput]> {
    const PRECISION = 6;
    const result = await execAsync(`exiftool -g -json -d "%s" -c "%+.${PRECISION}f" "${dirPath}"`);
    const json = JSON.parse(result.stdout);
    return json;
}

interface FfprobeOutput {
    // ...many other things...
    format: {
        filename: string;
        tags: {
            "com.apple.quicktime.content.identifier": string | undefined;
        }
    }
}
async function getFfprobeData(path: string): Promise<FfprobeOutput> {
    const result = await execAsync(`ffprobe -print_format json -v quiet -hide_banner -show_format "${path}"`);
    // console.log(result.stdout);
    const json = JSON.parse(result.stdout);
    return json;
}

// async function getImageMetadata(path: string): Promise<any> {
//     const exifToolData = await getExifToolData(path);

//     // if (exifToolData.MakerNotes && "ContentIdentifier" in exifToolData.MakerNotes)
//     // {
//     //     console.log(exifToolData.MakerNotes.ContentIdentifier);
//     // }

//     // if (exifToolData.Composite)
//     // {
//     //     console.log(exifToolData.Composite.GPSLatitude);
//     //     console.log(exifToolData.Composite.GPSLongitude);
//     // }

//     return {};
// }

interface Timestamp {
    timestamp: string;
    formatted: string;
}
interface GeoData {
    latitude: number;
    longitude: number;
    altitude: number;
    latitudeSpan: number;
    longitudeSpan: number;
}
interface MetadataJson {
    title: string;
    description: string;
    access: string;
    date: Timestamp,
    location: string;
    geoData: GeoData;
}
function parseMetadataJson(metadataJsonPath: string): MetadataJson {
    const json = JSON.parse(fs.readFileSync(metadataJsonPath).toString('utf-8'));
    return json as MetadataJson;
}

interface ImageMetadataJson {
    title: string;
    description: string;
    imageViews: string;
    creationTime: Timestamp;
    photoTakenTime: Timestamp;
    geoData: GeoData;
    geoDataExif: GeoData;
    url: string;
    googlePhotosOrigin: {
        mobileUpload: {
            deviceType: "IOS_PHONE" | string;
        }
    } | unknown;
    photoLastModifiedTime: Timestamp;
}
function parseImageMetadataJson(jsonPath: string): ImageMetadataJson {
    const json = JSON.parse(fs.readFileSync(jsonPath).toString('utf-8'));
    return json as ImageMetadataJson;
}

type ContentInfo = {
    video?: {
        metadata: FfprobeOutput;
        livePhotoId?: string;
    };
    image?: {
        metadata: ExifToolOutput;
        livePhotoId?: string;
        size: number;
    }
    photosId?: string | null;
    path: string;
    manifest?: {
        path: string;
        metadata: ImageMetadataJson;
    }
};

function getImageInfo(i: ContentInfo) {
    // Again:
    //
    // - the actual file name can be truncated if it's too long
    //
    // TODO: this is still not finding any photos for Leah visits.
    //
    // TODO: switching between Google's date and the EXIF date can fix
    // some timestamp errors but causes others. Also, DSLRs dates are
    // super wrong sometimes. I think we need to use an actual image
    // diff if we have options that match in size but not in timestamp.
    return {
        image_filename: i.manifest?.metadata.title || path.basename(i.path),
        image_timestamp:  i.image?.metadata.Composite.SubSecDateTimeOriginal || "", // TODO: date time for video?

        // Prefer image path for size, since that's what Photos uses for Live Photos.
        image_size: i.image?.size || 0, // TODO: what if no image? 
    };
}

interface IAlbum {
    title: string;
    dirs: string[];
    existingPhotosInfo: { 
        id: string;
        originalCount: number;
    } | null;
    metadata: MetadataJson | null;
    content: ContentInfo[];
    manifests: {
        path: string;
        metadata: ImageMetadataJson;
    }[];
}
async function parseLibrary(takeout_dir: string): Promise<IAlbum[]> {
    const files = fs.readdirSync(takeout_dir, { withFileTypes: true });
    
    // TODO: handle someone giving the "Google Photos" directory or a directory containing Google Photos directly.
    const dirs = files.filter((f)=> f.isDirectory());
    const google_photos_dirs = dirs.map((f) => path.join(takeout_dir, f.name, "Google Photos"));
    
    google_photos_dirs.filter((d) => {
        const doesExist = fs.existsSync(d);
        if (!doesExist) {
            console.warn(`Ignoring ${d} (doesn't exist).`);
        }
        return doesExist;
    });
    
    console.log("Reading from:", google_photos_dirs);
    
    const albumFolders = google_photos_dirs.map((d) => {
        const files = fs.readdirSync(d, { withFileTypes: true });
        const dirs = files.filter((f)=> f.isDirectory());
        const full_dirs = dirs.map((f) => path.join(d, f.name));
        return full_dirs;
    }).flat().reduce<{ name: string; dirs: string[]; }[]>((acc, cur) => {
        const album_title = path.basename(cur);
        const existing = acc.find((v) => v.name === album_title);
        if (existing) {
            existing.dirs.push(cur);
        } else {
            acc.push({
                name: album_title,
                dirs: [cur],
            });
        }
        return acc;
    }, []);

    const photosAlbums = getPhotosAlbums();
   
    const albums = await Promise.all(albumFolders.map(async (a): Promise<IAlbum> => {    
        const items = a.dirs.map((d) => fs.readdirSync(d).map(f => path.join(d, f)) ).flat();
        const VIDEO_TYPES = [
            ".MOV",
            ".MP4", 
            ".M4V",
        ];
        const IMAGE_TYPES = [
            ".GIF", 
            ".HEIC",
            ".JPG",
            ".JPEG", 
            ".PNG", 
        ];
        const KNOWN_TYPES = [
            ... VIDEO_TYPES,
            ... IMAGE_TYPES,
        ];
        const images_and_movies = items.filter((i) => {
            return KNOWN_TYPES.includes(path.extname(i).toUpperCase());
        });
    
        const jsons = items.filter((i) => {
            return path.extname(i) === ".json";
        });

        let metadata: MetadataJson | null = null;
        const metadataJsonIndex = jsons.findIndex(i => path.basename(i) === "metadata.json");
        const metadataJson = (metadataJsonIndex === -1) ? null : jsons.splice(metadataJsonIndex, 1)[0];
        if (metadataJson) {
            metadata = parseMetadataJson(metadataJson);
        }
        const title = metadata?.title || a.name;
        
        const remaining = items.filter((i) => !images_and_movies.includes(i) && !jsons.includes(i) && (!metadataJson || i !== metadataJson));
        if (remaining.length !== 0) {
            console.warn(`Unrecognized objects: ${remaining.map(r => r).join(",\r\n")}`);
        }

        const parsedJsons = jsons.map((p) => {
            return {
                path: p,
                metadata: parseImageMetadataJson(p),
            }
        });
    
        const exifs = (await Promise.all(a.dirs.map(async (d) => await getExifToolDataForDirectory(d)))).flat();

        // Ensure we have JSONs for each image/movie:
        const parsed_images: ContentInfo[] = [];
        for (const itemPath of images_and_movies) {
            const quickImageName = path.basename(itemPath);

            // First, we need to see if this a live photo.
            const isVideo = VIDEO_TYPES.includes(path.extname(itemPath));
            const metadata = (isVideo) ? await getFfprobeData(itemPath) : exifs.find((e) => e.SourceFile === itemPath);
            if (!metadata) {
                throw new Error(`No metadata for ${title} - ${quickImageName}`);
            }

            const livePhotoId = (isVideo)
                ? (metadata as FfprobeOutput).format.tags["com.apple.quicktime.content.identifier"]
                : (metadata as ExifToolOutput).MakerNotes?.ContentIdentifier;
            const existingIndex = (livePhotoId) ? parsed_images.findIndex((c) => {
                    if (c.image) {
                        return c.image.livePhotoId === livePhotoId;
                    } else {
                        if (!c.video) {
                            throw new Error(`Invalid parsed image: ${c}`);
                        }
                        return c.video!.livePhotoId === livePhotoId;
                    }
                }) : -1;

            const getMatchingManifest = () => {
                const baseName = path.basename(itemPath);
                const exactMatch = parsedJsons.find((j) => path.parse(j.path).name === baseName);
                if (exactMatch) {
                    return exactMatch;
                }

                // Names like
                // 58535142263__8767EB8A-D857-4A0E-9C1F-17EAFC8DB4EC.JPG seem to
                // occassionally be truncated:
                // 58535142263__8767EB8A-D857-4A0E-9C1F-17EAFC8DB4, for example.
                if (baseName.length === 51) {
                    // console.log(baseName, baseName.length);
                    const noExt = path.parse(itemPath).name;
                    const ext = path.parse(itemPath).ext;
                    const smallMatch = parsedJsons.find((j) => j.metadata.title.indexOf(noExt) !== -1 && path.extname(j.metadata.title) === ext);
                    // console.log(noExt, ext, !!smallMatch);
                    return smallMatch;
                }

                return null;
            };

            if (existingIndex !== -1) {
                // Add the info.

                const extraJson = getMatchingManifest();
                if (parsed_images[existingIndex].manifest) {
                    if (extraJson) {
                        console.warn(`Redundant JSON found for ${title} - ${quickImageName}`);
                    }
                } else {
                    if (!extraJson) {
                        console.warn(`No JSON found for ${title} - ${quickImageName} (or live counterpart)`);
                    } else {
                        parsed_images[existingIndex].manifest = extraJson;
                    }
                }

                // Match GPS data
                if (!isVideo)
                {
                    const json = parsed_images[existingIndex].manifest;
                    const exif = metadata as ExifToolOutput;
                    const hasMetadataGeoData = json?.metadata.geoData.latitude && json?.metadata.geoData.longitude;
                    const hasMetadataGeoDataExif = json?.metadata.geoDataExif.latitude && json?.metadata.geoDataExif.longitude;
                    const hasGeoData = exif.Composite.GPSLatitude && exif.Composite.GPSLongitude;
                    if (hasMetadataGeoData || hasMetadataGeoDataExif) {
                        if (hasGeoData) {
                            const GPS_PRECISION = Math.pow(10, -4);
                            const latLon = {
                                lat: Number.parseFloat(exif.Composite.GPSLatitude!.toString()),
                                lon: Number.parseFloat(exif.Composite.GPSLongitude!.toString())
                            };
                            const geoDataDist =
                                distance({
                                    lat: json.metadata.geoData.latitude,
                                    lon: json.metadata.geoData.longitude
                                }, latLon);
                            const geoDataMatch = geoDataDist < GPS_PRECISION;
                            const geoDataExifDist =
                                distance({
                                    lat: json.metadata.geoDataExif.latitude,
                                    lon: json.metadata.geoDataExif.longitude
                                }, latLon);
                            const geoDataExifMatch = geoDataExifDist < GPS_PRECISION;
                            if (!geoDataMatch || !geoDataExifMatch) {
                                console.warn(`Geodata mismatch: ${title} - ${quickImageName} (${json.metadata.geoDataExif.latitude}, ${json.metadata.geoDataExif.longitude} [${geoDataDist}] & ${json.metadata.geoData.latitude}, ${json.metadata.geoData.longitude} [${geoDataExifDist}] => ${latLon.lat}, ${latLon.lon})`);
                            }
                        } else {
                            console.warn(`No EXIF location data, but location metadata for ${title} - ${quickImageName}`);
                        }
                    } else if (hasGeoData) {
                        console.warn(`Has EXIF data but no location metadata ${title} - ${quickImageName}`);
                    }
                }

                if (isVideo) {
                    parsed_images[existingIndex].video = {
                        livePhotoId: livePhotoId,
                        metadata: metadata as FfprobeOutput
                    };
                } else {
                    parsed_images[existingIndex].image = {
                        livePhotoId: livePhotoId,
                        metadata: metadata as ExifToolOutput,
                        size: fs.statSync(itemPath).size,
                    };
                }
            } else {
                // Create a new one. Grab metadata.
                const json = getMatchingManifest()!;

                parsed_images.push({
                    path: itemPath,
                    manifest: json,
                    image: (isVideo) ? undefined : {
                        livePhotoId: livePhotoId,
                        metadata: metadata as ExifToolOutput,
                        size: fs.statSync(itemPath).size,
                    },
                    video: (!isVideo) ? undefined : {
                        livePhotoId: livePhotoId,
                        metadata: metadata as FfprobeOutput,
                    }
                });
            }
        }

        const correspondingPhotosAlbum = photosAlbums.find((pa) => pa.name === title);
        const photosInfo = (correspondingPhotosAlbum)
            ? {
                id: correspondingPhotosAlbum.id,
                originalCount: getAlbumPhotosCount(correspondingPhotosAlbum.id)!
            }
            : null;

        return {
            title: title,
            existingPhotosInfo: photosInfo,
            dirs: a.dirs,
            metadata: metadata,
            content: parsed_images,
            manifests: parsedJsons,
        }
    }));

    // Now, find IDs for all the photos in Photos!
    console.log("Finding existing photos in Photos app (this may take a while)...");
    albums.forEach((a) => {
        const images_to_find = a.content.map((i) => getImageInfo(i));
        const ids = findPhotoInPhotos(images_to_find);
        const foundTotal = ids.filter((i) => !!i).length;
        const imageCount = a.content.length;
        if (foundTotal === imageCount) {
            console.log(`Found for album ${a.title} - all ${imageCount}`);
        } else {
            console.log(`Found for album ${a.title} - ${foundTotal} / ${imageCount}`);
        }
        for (let i = 0; i < ids.length; i++) {
            a.content[i].photosId = ids[i];
        }
    });

    return albums;
}

async function main() {
    if (process.argv.length != 3) {
        console.error(`Wrong number of arguments; try 'npm run go -- path/here/'\r\n\r\n(${process.argv})`);
        process.exit(1);
    }
    
    const takeout_dir = process.argv[2];
    const is_reading_existing_parse = path.extname(takeout_dir) === ".json";
    let albums: IAlbum[];
    if (is_reading_existing_parse) {
        const library_data = fs.readFileSync(takeout_dir);
        albums = JSON.parse(library_data.toString('utf-8')) as IAlbum[];
    } else {
        albums = await parseLibrary(takeout_dir);
    }

    // Augment this data with stuff from previous runs:
    const RUN_PREFIX = "run-";
    const CREATED_ALBUMS_JSON = "created_albums.json";
    const IMPORTED_IMAGES_JSON = "imported_images.json";
    type CreatedAlbum = {
        title: string,
        id: string
    };
    type ImportedImage = {
        photosId: string,
        path: string,
        albumId: string,
    };
    const currentDir = fs.readdirSync(".", { withFileTypes: true });
    const previousRuns = currentDir.filter((i) => i.isDirectory() && i.name.startsWith(RUN_PREFIX));
    previousRuns.forEach((run) => {
        const albums_file = fs.readdirSync(".", { withFileTypes: true }).find((i) => i.isFile() && i.name === CREATED_ALBUMS_JSON);
        const images_file = fs.readdirSync(".", { withFileTypes: true }).find((i) => i.isFile() && i.name === CREATED_ALBUMS_JSON);

        if (albums_file) {
            const parsed_albums: CreatedAlbum[] = JSON.parse(fs.readFileSync(albums_file.name).toString("utf8"));
            parsed_albums.forEach((pa) => {
                const correspondingIndex = albums.findIndex((a) => a.title === pa.title);
                if (correspondingIndex === -1) {
                    throw new Error(`Missing corresponding album for ${pa.title}, ${pa.id}`);
                }

                if (albums[correspondingIndex].existingPhotosInfo) {
                    throw new Error(`Already have photos info for ${pa.title}, ${pa.id}: ${albums[correspondingIndex].existingPhotosInfo}`);
                }

                const count = getAlbumPhotosCount(pa.id)!;

                albums[correspondingIndex].existingPhotosInfo = {
                    id: pa.id,
                    originalCount: count
                };
            });
            console.log(`Augmented with ${parsed_albums.length} albums from previous runs.`);
        }

        if (images_file) {
            const joinedText = `[${fs.readFileSync(images_file.name).toString("utf8")}]`;
            const parsed_images: ImportedImage[] = JSON.parse(joinedText);
            parsed_images.forEach((pi) => {
                const correspondingAlbumIndex = albums.findIndex((a) => a.existingPhotosInfo?.id === pi.albumId);
                if (correspondingAlbumIndex === -1) {
                    throw new Error(`Missing corresponding album for ${pi.path}, ${pi.albumId}`);
                }
                const correspondingPhotoIndex = albums[correspondingAlbumIndex].content.findIndex((i) => i.path === pi.path);
                if (correspondingPhotoIndex === -1) {
                    throw new Error(`Missing corresponding photo for ${pi.path}, ${pi.albumId}`);
                }

                albums[correspondingAlbumIndex].content[correspondingPhotoIndex].photosId === pi.photosId;
            });
            console.log(`Augmented with ${parsed_images.length} imported images from previous runs.`);
        }
    });

    console.log();
    
    albums.forEach((a) => {
        console.log(a.title);
        console.log(`\tin: ${a.dirs.map((p) => {
            const gphotosIndex = p.indexOf("Google Photos");
            const trim = p.substring(0, gphotosIndex);
            return path.basename(trim);
        }).join(", ")}`);
        if (a.metadata) {
            console.log("\t(has metadata)")
        }
        if (a.existingPhotosInfo) {
            console.log(`\t=> ID: ${a.existingPhotosInfo.id}`);

            // We don't really handle existing photos well.
            if (a.existingPhotosInfo.originalCount) {
                console.log(`\t\tWARNING: existing photos: ${a.existingPhotosInfo.originalCount}`);
            }
        } else {
            console.log(`\t=> (no Photos album)`);
        }
        console.log(`\tManifests: ${a.manifests.length}`);
        const livePhotoCount = a.content.filter((c) => c.image?.livePhotoId).length;
        const notImported = a.content.filter((c) => !c.photosId).length;
        const noManifest = a.content.filter((c) => !c.manifest).length; // TODO: do something with this.
        if (noManifest) {
            console.log(`\tActual images: ${a.content.length} (${livePhotoCount} are live) (${notImported} not imported) (no manifest: ${noManifest})`);
        } else {
            console.log(`\tActual images: ${a.content.length} (${livePhotoCount} are live) (${notImported} not imported)`);
        }
        console.log();
    });

    const all_images = albums.map(a => a.content).flat();
    console.log(`Total images & videos: ${all_images.length}`);

    const notImported = all_images.filter((c) => !c.photosId);
    console.log(`Not imported: ${notImported.length}`);

    const noManifest = all_images.filter((c) => !c.manifest);
    console.log(`No manifest: ${noManifest.length}`);

    const noLocation = all_images.filter(i => i.image && !i.image.metadata.Composite.GPSLatitude);
    console.log(`Images with no location info: ${noLocation.length}`);

    // Unpaired Live Photos cause problems?
    const unpairedLivePhotos = all_images.filter(i => (!i.image != !i.video) && (i.image?.livePhotoId || i.video?.livePhotoId));
    console.log(`Unpaired live photos: ${unpairedLivePhotos.length}`);
    unpairedLivePhotos.forEach((p) => {
        console.log(p.path);
    });
    console.log();

    // Long names (>51 chars) like
    // `57129642196__B027A842-8129-4128-8354-E415D2100BB3.JPG` seem to confuse
    // Photos. We'll have detected them earlier, just log them here.
    // const misNamed = all_images.filter(i => i.manifest && path.parse(i.path).name !== path.parse(i.manifest.metadata.title).name);
    // console.log(`Manifest/name mismatch: ${misNamed.length}`);
    // misNamed.forEach((p) => {
    //     console.log(p.path, /* path.parse(p.path).base, */ p.manifest?.metadata.title);
    // });
    // console.log();

    const dateMismatch = all_images.filter(i => {
        if (!i.manifest) { return false; }

        const googleTime = parseInt(i.manifest.metadata.photoTakenTime.timestamp);
        const photoTime = i.image?.metadata.Composite.SubSecDateTimeOriginal;
        if (!photoTime) {
            return false;
        }

        const timeDiff = Math.abs(googleTime - photoTime);
        return timeDiff > 2;
    });
    console.log(`Date mismatch: ${dateMismatch.length}`);
    dateMismatch.forEach((p) => {
        console.log(p.path, /* path.parse(p.path).base, */ p.manifest?.metadata.title);
    });
    console.log();

    if (!is_reading_existing_parse) {
        // Debug
        fs.writeFileSync("output.json", JSON.stringify(albums, undefined, 4));
    }

    const run_id = crypto.randomBytes(16).toString("hex");
    const run_folder = `${RUN_PREFIX}${run_id}`;
    fs.mkdirSync(run_folder);

    // Actions
    if (DO_ACTIONS) {

        console.log();
        console.log("Actions:");
        console.log();
        
        console.log("- create missing albums");
        const albums_to_create = albums.filter((a) => !a.existingPhotosInfo);
        const new_ids: CreatedAlbum[] = albums_to_create.map<CreatedAlbum | undefined>((a) => {
            console.log(`\t- ${a.title}`);

            if (!WHAT_IF) {
                const id = findOrCreateAlbum(a.title);
                a.existingPhotosInfo = {
                    id: id,
                    originalCount: 0,
                }

                return {
                    title: a.title,
                    id: id,
                };
            }
        }).filter<CreatedAlbum>((v): v is CreatedAlbum => !!v);
        if (!WHAT_IF) {
            fs.writeFileSync(path.join(run_folder, CREATED_ALBUMS_JSON), JSON.stringify(new_ids, undefined, 4));
        }

        console.log("- move existing photos into albums");
        albums.forEach((a) => {
            // No harm redoing this on subsequent runs.
            const ids = a.content.map((c) => c.photosId).filter((id) => !!id) as string[];
            const added = addPhotosToAlbumIfMissing(a.title, ids, WHAT_IF);
        });

        const imported_file = path.join(run_folder, IMPORTED_IMAGES_JSON);
        console.log("- import missing photos (and add import tag)");
        const renamedFilesDir = path.join(os.tmpdir(), "photos_import_renamed_images", run_id);
        fs.mkdirSync(renamedFilesDir, { recursive: true });
        console.log(`\t(created dir for renamed photos: ${renamedFilesDir})`);
        albums.forEach((a) => {
            const nonImportedPhotos = a.content.filter((c) => !c.photosId);
            const files = nonImportedPhotos.map((c) => {
                const desiredName = c.manifest && path.parse(c.manifest.metadata.title).name;
                const currentName = path.parse(c.path).name;
                const isMisnamed = c.manifest && desiredName !== currentName;
                if (isMisnamed) {
                    const destinationName = path.join(renamedFilesDir, c.manifest!.metadata.title);
                    fs.copyFileSync(c.path, destinationName);
                    if (c.image && c.video) {
                        // Add the other thing, image or video.
                        const isMainItemAnImage = path.extname(destinationName) === path.extname(c.image.metadata.SourceFile);
                        const additionalPathToUse = (isMainItemAnImage) ? c.video.metadata.format.filename : c.image.metadata.SourceFile;
                        const newExt = path.extname(additionalPathToUse);
                        const rawPath = destinationName.substring(0, destinationName.indexOf(path.extname(destinationName)));
                        const extraPath = rawPath + newExt;
                        fs.copyFileSync(additionalPathToUse, extraPath);

                        return [
                            destinationName,
                            extraPath
                        ];
                    } else {
                        return [
                            destinationName
                        ];
                    }
                } else {
                    const files = [];
                    if (c.image) {
                        files.push(c.image.metadata.SourceFile);
                    }
                    if (c.video) {
                        files.push(c.video.metadata.format.filename);
                    }
                    return files;
                }
            }).flat();
    
            console.log(`\t- Importing for ${a.title}:`);
            const newIds = importPhotosToAlbumChunked(a.title, files, WHAT_IF);
            if (!WHAT_IF) {
                files.forEach((f) => {
                    console.log(`\t\t- ${f}`);
                });
            }

            const importedImageInfo = getInfoForPhotoIds(newIds);
            importedImageInfo.forEach((img) => {
                const corresponding = a.content.findIndex((c) => {
                    const info = getImageInfo(c);
                    // Man, these timestamps & sizes just *love* causing
                    // trouble. Ignore them for now. We eventually throw if
                    // there are duplicatly named files.
                    //
                    // Also special case for videos.
                    return (info.image_filename === img.filename || path.basename(c.video?.metadata.format.filename || "") === img.filename) /* &&
                        (info.image_size === img.size) &&
                        (info.image_timestamp === img.timestamp) */;
                });
                if (corresponding === -1) {
                    const hasItemsWithNoManifest = a.content.filter((c) => !c.manifest).length !== 0;
                    if (hasItemsWithNoManifest) {
                        // We could simply have an item that *needs* a rename
                        // and doesn't get one because we are missing a
                        // manifest. Warn instead.
                        console.log(`WARNING: Could not find image in json for imported file - ${img.filename} size: ${img.size}, timestamp: ${img.timestamp} (${img.id})`);
                        return;
                    } else {
                        throw new Error(`Could not find image in json for imported file - ${img.filename} size: ${img.size}, timestamp: ${img.timestamp} (${img.id})`);
                    }
                }

                if (a.content[corresponding].photosId) {
                    console.log(`WARNING: Already have an ID for file - ${img.filename} size: ${img.size}, timestamp: ${img.timestamp} (${img.id})`);
                    return;
                }

                a.content[corresponding].photosId = img.id;
                const logData: ImportedImage = {
                    photosId: img.id,
                    path: a.content[corresponding].path,
                    albumId: a.existingPhotosInfo?.id!
                };
                fs.appendFileSync(imported_file, JSON.stringify(logData, undefined, 4) + ",");
            });
        });

        console.log();
        console.log("Import complete! Here's what's left (basically: files that Photos thought were duplicates; you'll need to add them to albums manually.");
        console.log();

        // Summarize import.
        albums.forEach((a) => {
            const notImported = a.content.filter((c) => !c.photosId);

            if (notImported.length === 0) {
                console.log(`${a.title} => all imported.`);
            } else {
                console.log(`${a.title} => missing ${notImported.length}:`);
                notImported.forEach((c) => {
                    console.log(`\t- ${c.path}`);
                });
            }
        });

        // if (!is_reading_existing_parse) {
            // Debug
            fs.writeFileSync("final.json", JSON.stringify(albums, undefined, 4));
        // }
    }

    // const inspect = albums.slice(0, 3);
    // const inspect = albums.map(a => a.content).flat().filter(i => (!i.image != !i.video) && (i.image?.livePhotoId || i.video?.livePhotoId));
    // const inspect = albums.map(a => a.content).flat().filter(i => i.image && !i.image.metadata.Composite.GPSLatitude);
    // console.dir(inspect, { depth: 5})
    // console.log(inspect.length);
}

main();

// console.log(chunk([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], 3));

// const photos = [
//     {
//         image_filename: "IMG_2811.HEIC",
//         image_timestamp: 1553394810,
//         image_size: 433445,
//     }
// ];
// console.log(photos);
// console.log(findPhotoInPhotos(photos));

// console.log(getInfoForPhotoIds([
//     "C089130D-0123-44E3-A5C1-74F6A4D63E82/L0/001",
// ]));
