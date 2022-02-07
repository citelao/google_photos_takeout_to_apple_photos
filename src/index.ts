import fs from "fs";
import path from "path";
import exifr from "exifr";
import util from "util";
import child_process from "child_process";
const exec = util.promisify(require('child_process').exec);

function toFixed(n: number | string, digits: number): number {
    if (typeof n === "string") {
        n = Number.parseFloat(n);
    }
    return Math.round((n + Number.EPSILON) * Math.pow(10, digits)) / Math.pow(10, digits);
}

function distance(a: { lat: number; lon: number; }, b: { lat: number; lon: number; }): number {
    // console.log(a, b);
    return Math.sqrt(Math.pow(a.lat - b.lat, 2) + Math.pow(a.lon - b.lon, 2));
}

async function execAsync(cmd: string): Promise<{ stdout: string; stderr: string; }> {
    const result: { stdout: string, stderr: string } = await exec(cmd);

    // TODO: handle errors?
    // if (result.stderr) {
    //     throw new Error(`exiftool failed: ${result.stderr}`);
    // }

    return result;
}

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

function findPhotoInPhotos(images: {image_filename: string, image_timestamp: number | string, image_size: number}[]): (string | null)[] {
    // Derived from https://github.com/akhudek/google-photos-to-apple-photos/blob/main/migrate-albums.py
    const DIVIDER = "✂";
    const TIMESTAMP_TOLERANCE = "1";
    const FIND_PHOTO_SCRIPT = `
        on unixDate(datetime)
            set command to "date -j -f '%A, %B %e, %Y at %I:%M:%S %p' '" & datetime & "'"
            set command to command & " +%s"
            
            set theUnixDate to do shell script command
            return theUnixDate
        end unixDate

        on tryGetImage(image_filename, image_timestamp, image_size)
            tell application "Photos"
                set images to search for image_filename

                repeat with img in images
                    set myFilename to filename of img
                    set myTimestamp to my unixDate(get date of img)
                    set mySize to size of img                
                    if image_filename is equal to myFilename and mySize is equal to (image_size as integer)
                        if image_timestamp is equal to ""
                            return (get id of img)
                        end if

                        set time_diff to image_timestamp - myTimestamp
                        if time_diff < 0 then
                            set abs_time_diff to -time_diff
                        else
                            set abs_time_diff to time_diff
                        end if

                        if abs_time_diff <= ${TIMESTAMP_TOLERANCE} then
                            return (get id of img)
                        end if
                    end if
                end repeat

                return ""
            end tell
        end tryGetImage

        on run argv
            set output to ""
            set currentIndex to 1
            repeat while currentIndex <= length of argv
                set image_filename to item currentIndex of argv
                set image_timestamp to item (currentIndex + 1) of argv 
                set image_size to item (currentIndex + 2) of argv
                set output to output & (my tryGetImage(image_filename, image_timestamp, image_size)) & "${DIVIDER}"
                set currentIndex to currentIndex + 3
            end repeat

            return output
        end run
    `;
    const flatArgs = images.map((i) => [i.image_filename, i.image_timestamp.toString(), i.image_size.toString()]).flat();
    const result = child_process.spawnSync("osascript", ["-", ... flatArgs], { input: FIND_PHOTO_SCRIPT});
    const output = result.stdout.toString("utf-8");
    if (result.stderr.length != 0) {
        throw new Error(result.stderr.toString("utf-8"));
    }
    const ids = output.split(DIVIDER);
    ids.pop(); // The last one is always that extra scissor.
    return ids.map((i) => i.trim() || null);
}

type ContentInfo = {
    video?: {
        metadata: FfprobeOutput;
        livePhotoId?: string;
    };
    image?: {
        metadata: ExifToolOutput;
        livePhotoId?: string;
    }
    photosId?: string | null;
    path: string;
    manifest?: {
        path: string;
        metadata: ImageMetadataJson;
    }
};
interface IAlbum {
    title: string;
    dirs: string[];
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
    
    const albums = await Promise.all(albumFolders.map(async (a) => {    
        const items = a.dirs.map((d) => fs.readdirSync(d).map(f => path.join(d, f)) ).flat();
        const VIDEO_TYPES = [
            ".MOV",
            ".MP4", 
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
            console.warn(`Unrecognized objects: ${remaining.map(r => r)}`);
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
                        metadata: metadata as ExifToolOutput
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
                    },
                    video: (!isVideo) ? undefined : {
                        livePhotoId: livePhotoId,
                        metadata: metadata as FfprobeOutput,
                    }
                });
            }
        }

        return {
            title: title,
            dirs: a.dirs,
            metadata: metadata,
            content: parsed_images,
            manifests: parsedJsons,
        }
    }));

    // Now, find IDs for all the photos in Photos!
    albums.forEach((a) => {
        const images_to_find = a.content.map((i) => {
            return {
                image_filename: i.manifest?.metadata.title || path.basename(i.path),
                image_timestamp: i.image?.metadata.Composite.SubSecDateTimeOriginal || "", // TODO: date time for video?
                image_size: fs.statSync(i.path).size,
            };
        });
        const ids = findPhotoInPhotos(images_to_find);
        console.log(ids);
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

    if (!is_reading_existing_parse) {
        // Debug
        fs.writeFileSync("output.json", JSON.stringify(albums, undefined, 4));
    }

    // const inspect = albums.slice(0, 3);
    // const inspect = albums.map(a => a.content).flat().filter(i => (!i.image != !i.video) && (i.image?.livePhotoId || i.video?.livePhotoId));
    // const inspect = albums.map(a => a.content).flat().filter(i => i.image && !i.image.metadata.Composite.GPSLatitude);
    // console.dir(inspect, { depth: 5})
    // console.log(inspect.length);
}

main();