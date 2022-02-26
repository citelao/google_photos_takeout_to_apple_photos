import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { distance } from "./numbers";
import Logger from "./Logger";
import { getPhotosAlbums, findPhotoInPhotos, findOrCreateAlbum, addPhotosToAlbumIfMissing, getAlbumPhotosCount, getInfoForPhotoIds, importPhotosToAlbumChunked, chunked, importPhotosToAlbum } from "./photos_app";
import chalk from "chalk";

import { program } from "commander";
import { FfprobeOutput, ExifToolOutput, getExifToolDataForDirectory, getFfprobeData } from "./image_data";
import { ImageMetadataJson, AlbumMetadataJson, parseAlbumMetadataJson, parseImageMetadataJson } from "./google_manifests";

program
    .argument('<takeout_path_or_preparsed_file>', 'Google Takeout directories or parsed file')
    .option('-w --whatif', 'what if?')
    .option('-d --do_actions', 'actually perform actions, not just parse');

program.parse();

const do_actions: boolean = program.opts().do_actions;
const what_if: boolean = program.opts().whatif;

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
        image_timestamp:  i.image?.metadata.Composite.SubSecDateTimeOriginal, // TODO: date time for video?

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
    metadata: AlbumMetadataJson | null;
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
            Logger.warn(`Ignoring ${d} (doesn't exist).`);
        }
        return doesExist;
    });
    
    Logger.log("Reading from:", google_photos_dirs);
    
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
            ".NEF"
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

        let metadata: AlbumMetadataJson | null = null;
        const metadataJsonIndex = jsons.findIndex(i => path.basename(i) === "metadata.json");
        const metadataJson = (metadataJsonIndex === -1) ? null : jsons.splice(metadataJsonIndex, 1)[0];
        if (metadataJson) {
            metadata = parseAlbumMetadataJson(metadataJson);
        }
        const title = metadata?.title || a.name;
        
        const remaining = items.filter((i) => !images_and_movies.includes(i) && !jsons.includes(i) && (!metadataJson || i !== metadataJson));
        if (remaining.length !== 0) {
            Logger.warn(`Unrecognized objects: ${remaining.map(r => r).join(",\r\n")}`);
        }

        const parsedJsons = jsons.map((p) => {
            return {
                path: p,
                metadata: parseImageMetadataJson(p),
            }
        });
    
        Logger.log(chalk.gray(`${a.name} - Getting EXIF data...`));
        const exifs = (await Promise.all(a.dirs.map(async (d) => await getExifToolDataForDirectory(d)))).flat();

        // Ensure we have JSONs for each image/movie:
        Logger.log(chalk.gray(`${a.name} - Finding manifests...`));
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
                    // Logger.log(baseName, baseName.length);
                    const noExt = path.parse(itemPath).name;
                    const ext = path.parse(itemPath).ext;
                    const smallMatch = parsedJsons.find((j) => j.metadata.title.indexOf(noExt) !== -1 && path.extname(j.metadata.title) === ext);
                    // Logger.log(noExt, ext, !!smallMatch);
                    return smallMatch;
                }

                return null;
            };

            if (existingIndex !== -1) {
                // Add the info.

                const extraJson = getMatchingManifest();
                if (parsed_images[existingIndex].manifest) {
                    if (extraJson) {
                        Logger.warn(`Redundant JSON found for ${title} - ${quickImageName}`);
                    }
                } else {
                    if (!extraJson) {
                        Logger.warn(`No JSON found for ${title} - ${quickImageName} (or live counterpart)`);
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
                                Logger.warn(`Geodata mismatch: ${title} - ${quickImageName} (${json.metadata.geoDataExif.latitude}, ${json.metadata.geoDataExif.longitude} [${geoDataDist}] & ${json.metadata.geoData.latitude}, ${json.metadata.geoData.longitude} [${geoDataExifDist}] => ${latLon.lat}, ${latLon.lon})`);
                            }
                        } else {
                            Logger.warn(`No EXIF location data, but location metadata for ${title} - ${quickImageName}`);
                        }
                    } else if (hasGeoData) {
                        Logger.warn(`Has EXIF data but no location metadata ${title} - ${quickImageName}`);
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
    Logger.log("Finding existing photos in Photos app (this may take a while)...");
    albums.forEach((a) => {
        const images_to_find = a.content.map((i) => getImageInfo(i));
        Logger.log(chalk.grey(`\t${a.title} - Finding ${images_to_find.length}...`));
        const CHUNK_SIZE = 200;
        const ids = chunked(images_to_find, CHUNK_SIZE, (imgs, i, a) => {
            Logger.log(chalk.gray(`\t\tFinding ${CHUNK_SIZE} photos chunk ${i}/${a.length}...`));
            return findPhotoInPhotos(imgs);
        });
        const foundTotal = ids.filter((i) => !!i).length;
        const imageCount = a.content.length;
        if (foundTotal === imageCount) {
            Logger.log(`Found for album ${a.title} - all ${imageCount}`);
        } else {
            Logger.log(`Found for album ${a.title} - ${foundTotal} / ${imageCount}`);
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

    // Augment this data with stuff from previous runs.
    //
    // 2 stages: albums first, then photos.
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
        const albums_file = fs.readdirSync(run.name, { withFileTypes: true }).find((i) => i.isFile() && i.name === CREATED_ALBUMS_JSON);

        if (albums_file) {
            Logger.log(chalk.gray("Found albums file..."));
            const parsed_albums: CreatedAlbum[] = JSON.parse(fs.readFileSync(path.join(run.name, albums_file.name)).toString("utf8"));
            parsed_albums.forEach((pa) => {
                const correspondingIndex = albums.findIndex((a) => a.title === pa.title);
                if (correspondingIndex === -1) {
                    throw new Error(`Missing corresponding album for ${pa.title}, ${pa.id.trim()}`);
                }

                if (albums[correspondingIndex].existingPhotosInfo) {
                    throw new Error(`Already have photos info for ${pa.title}, ${pa.id.trim()}: ${albums[correspondingIndex].existingPhotosInfo}`);
                }

                Logger.log(chalk.gray(`\t - Getting items for ${pa.title} (${pa.id.trim()})...`));
                const count = getAlbumPhotosCount(pa.id.trim())!;

                albums[correspondingIndex].existingPhotosInfo = {
                    id: pa.id.trim(),
                    originalCount: count
                };
            });
            Logger.log(`Augmented with ${parsed_albums.length} albums from previous runs.`);
        }
    });

    previousRuns.forEach((run) => {
        const images_file = fs.readdirSync(run.name, { withFileTypes: true }).find((i) => i.isFile() && i.name === IMPORTED_IMAGES_JSON);
        
        if (images_file) {
            Logger.log(chalk.gray("Found images file..."));
            const readText = fs.readFileSync(path.join(run.name, images_file.name)).toString("utf8");            
            const joinedText = `[${readText.substring(0, readText.length - 1)}]`; // strip out the last comma.
            const parsed_images: ImportedImage[] = JSON.parse(joinedText);
            parsed_images.forEach((pi) => {
                const correspondingAlbumIndex = albums.findIndex((a) => a.existingPhotosInfo?.id.trim() === pi.albumId.trim());
                if (correspondingAlbumIndex === -1) {
                    throw new Error(`Missing album for ${pi.path} (wanted ${pi.albumId.trim()})`);
                }
                const correspondingPhotoIndex = albums[correspondingAlbumIndex].content.findIndex((i) => i.path === pi.path);
                if (correspondingPhotoIndex === -1) {
                    throw new Error(`Missing corresponding photo for ${pi.path}, ${pi.albumId}`);
                }

                albums[correspondingAlbumIndex].content[correspondingPhotoIndex].photosId === pi.photosId;
            });
            Logger.log(`Augmented with ${parsed_images.length} imported images from previous runs.`);
        }
    });

    Logger.log();
    
    albums.forEach((a) => {
        Logger.log(a.title);
        Logger.log(`\tin: ${a.dirs.map((p) => {
            const gphotosIndex = p.indexOf("Google Photos");
            const trim = p.substring(0, gphotosIndex);
            return path.basename(trim);
        }).join(", ")}`);
        if (a.metadata) {
            Logger.log("\t(has metadata)")
        }
        if (a.existingPhotosInfo) {
            Logger.log(`\t=> ID: ${a.existingPhotosInfo.id}`);

            // We don't really handle existing photos well.
            if (a.existingPhotosInfo.originalCount) {
                Logger.log(`\t\tWARNING: existing photos: ${a.existingPhotosInfo.originalCount}`);
            }
        } else {
            Logger.log(`\t=> (no Photos album)`);
        }
        Logger.log(`\tManifests: ${a.manifests.length}`);
        const livePhotoCount = a.content.filter((c) => c.image?.livePhotoId).length;
        const notImported = a.content.filter((c) => !c.photosId).length;
        const noManifest = a.content.filter((c) => !c.manifest).length; // TODO: do something with this.
        if (noManifest) {
            Logger.log(`\tActual images: ${a.content.length} (${livePhotoCount} are live) (${notImported} not imported) (no manifest: ${noManifest})`);
        } else {
            Logger.log(`\tActual images: ${a.content.length} (${livePhotoCount} are live) (${notImported} not imported)`);
        }
        Logger.log();
    });

    const all_images = albums.map(a => a.content).flat();
    Logger.log(`Total images & videos: ${all_images.length}`);

    const notImported = all_images.filter((c) => !c.photosId);
    Logger.log(`Not imported: ${notImported.length}`);

    const noManifest = all_images.filter((c) => !c.manifest);
    Logger.log(`No manifest: ${noManifest.length}`);

    const noLocation = all_images.filter(i => i.image && !i.image.metadata.Composite.GPSLatitude);
    Logger.log(`Images with no location info: ${noLocation.length}`);

    // Unpaired Live Photos cause problems?
    const unpairedLivePhotos = all_images.filter(i => (!i.image != !i.video) && (i.image?.livePhotoId || i.video?.livePhotoId));
    Logger.log(`Unpaired live photos: ${unpairedLivePhotos.length}`);
    unpairedLivePhotos.forEach((p) => {
        Logger.log(`\t${p.path}`);
    });
    Logger.log();

    // Long names (>51 chars) like
    // `57129642196__B027A842-8129-4128-8354-E415D2100BB3.JPG` seem to confuse
    // Photos. We'll have detected them earlier, just log them here.
    // const misNamed = all_images.filter(i => i.manifest && path.parse(i.path).name !== path.parse(i.manifest.metadata.title).name);
    // Logger.log(`Manifest/name mismatch: ${misNamed.length}`);
    // misNamed.forEach((p) => {
    //     Logger.log(p.path, /* path.parse(p.path).base, */ p.manifest?.metadata.title);
    // });
    // Logger.log();

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
    Logger.log(`Date mismatch: ${dateMismatch.length}`);
    dateMismatch.forEach((p) => {
        Logger.log("\t", p.path, /* path.parse(p.path).base, */ p.manifest?.metadata.title);
    });
    Logger.log();

    if (!is_reading_existing_parse) {
        // Debug
        fs.writeFileSync("output.json", JSON.stringify(albums, undefined, 4));
    }

    const run_id = crypto.randomBytes(16).toString("hex");
    const run_folder = `${RUN_PREFIX}${run_id}`;
    fs.mkdirSync(run_folder);

    // Actions
    if (do_actions) {

        Logger.log();
        Logger.log("Actions:");
        Logger.log();
        
        Logger.log("- create missing albums");
        const albums_to_create = albums.filter((a) => !a.existingPhotosInfo);
        const new_ids: CreatedAlbum[] = albums_to_create.map<CreatedAlbum | undefined>((a) => {
            Logger.log(`\t- ${a.title}`);

            if (!what_if) {
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
        if (!what_if && new_ids.length !== 0) {
            fs.writeFileSync(path.join(run_folder, CREATED_ALBUMS_JSON), JSON.stringify(new_ids, undefined, 4));
        }

        Logger.log("- move existing photos into albums");
        albums.forEach((a) => {
            // No harm redoing this on subsequent runs.
            const ids = a.content.map((c) => c.photosId).filter((id) => !!id) as string[];
            const added = addPhotosToAlbumIfMissing(a.title, ids, what_if);
        });

        const imported_file = path.join(run_folder, IMPORTED_IMAGES_JSON);
        Logger.log("- import missing photos (and add import tag)");
        const renamedFilesDir = path.join(os.tmpdir(), "photos_import_renamed_images", run_id);
        fs.mkdirSync(renamedFilesDir, { recursive: true });
        Logger.log(`\t(created dir for renamed photos: ${renamedFilesDir})`);
        albums.forEach((a) => {
            const nonImportedPhotos = a.content.filter((c) => !c.photosId);
            Logger.log(`\t- Identifying files for ${a.title}:`);
            // Don't flatten this array! If we detect live photos, we need to
            // ensure they aren't split when we chunk (below). Otherwise the ID
            // will go away and that will cause a ton of problems.
            const files = nonImportedPhotos.map((c) => {
                const desiredName = c.manifest && path.parse(c.manifest.metadata.title).name;
                const baseFiles: string[] = [];
                if (c.image) {
                    baseFiles.push(c.image.metadata.SourceFile);
                }

                if (c.video) {
                    baseFiles.push(c.video.metadata.format.filename);
                }

                return baseFiles.map((file) => {
                    const currentName = path.parse(file).name;
                    const isMisnamed = c.manifest && desiredName !== currentName;
                    if (isMisnamed) {
                        Logger.log(`\t\tMisnamed ${c.path} => ${desiredName}`);
                        const ext = path.parse(file).ext;
                        const newFilename = `${desiredName}${ext}`;
                        const destinationName = path.join(renamedFilesDir, newFilename);
                        fs.copyFileSync(c.path, destinationName);
                        return destinationName;
                    } else {
                        return file;
                    }
                });
            });
    
            Logger.log(`\t- Importing for ${a.title} (${files.flat().length} including dupes):`);
            // const IMPORT_CHUNK_SIZE = 200;
            // const newIds = chunked(files, IMPORT_CHUNK_SIZE, (inp, i, arr) => {
            //     Logger.log(chalk.gray(`\t\tImporting chunk ${i+1}/${arr.length}`));
            //     return importPhotosToAlbum(a.title, inp.flat(), WHAT_IF);
            // });
            const newIds = importPhotosToAlbum(a.title, files.flat(), what_if);
            // if (!WHAT_IF) {
            //     files.forEach((f) => {
            //         Logger.log(`\t\t- ${f}`);
            //     });
            // }
            Logger.verbose(newIds);
            Logger.log(`\t\t${newIds.length} imported.`);
            
            Logger.log(chalk.gray(`\t\tFetching info on imported photos...`));
            const importedImageInfo = getInfoForPhotoIds(newIds.map((i) => i.photoId));
            Logger.log(`\t\tFetched info for ${importedImageInfo.length} from Photos.`);
            importedImageInfo.forEach((img) => {
                let corresponding = a.content.findIndex((c) => {
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

                // Another chance to match; Photos likes to rename some photos (especially GUID files).
                if (corresponding === -1) {
                    const size_and_timestamp_matcher = (c: ContentInfo) => {
                        const info = getImageInfo(c);
                        // Photos seems to sue FileModifyDate if the Photo has no metadata.
                        return (info.image_size === img.size) &&
                            ((info.image_timestamp || c.image?.metadata.File.FileModifyDate) === img.timestamp);
                    }
                    const firstCorresponding = a.content.findIndex(size_and_timestamp_matcher);
                    const findLastIndex = <T>(arr: T[], fn: (input: T) => boolean): number => {
                        const index = arr.slice().reverse().findIndex(fn);
                        if (index === -1) {
                            return index;
                        }

                        // If `0`, return end of array; if last item in array, return 0.
                        return arr.length - 1 - index;
                    };
                    const lastCorresponding = findLastIndex(a.content, size_and_timestamp_matcher);

                    if (firstCorresponding !== -1) {
                        if (firstCorresponding === lastCorresponding) {
                            Logger.verbose(`\t\t\t- Matched based on size & timestamp for ${img.filename} size: ${img.size}, timestamp: ${img.timestamp} (${img.id}); index: ${firstCorresponding} (also ${lastCorresponding}). ${a.content[lastCorresponding].path}`);
                            corresponding = firstCorresponding;
                        } else {
                            Logger.warn(`\t\t\t- Multiple corresponding images found for ${img.filename} size: ${img.size}, timestamp: ${img.timestamp} (${img.id})... TODO.`);
                        }
                    }
                }

                if (corresponding === -1) {
                    const hasItemsWithNoManifest = a.content.filter((c) => !c.manifest).length !== 0;
                    if (hasItemsWithNoManifest) {
                        // We could simply have an item that *needs* a rename
                        // and doesn't get one because we are missing a
                        // manifest. Warn instead.
                        //
                        // TODO: we need to map the IDs; otherwise we will try
                        // to import this file again if you run again.
                        Logger.log(`WARNING: Could not find image in json for imported file - ${img.filename} size: ${img.size}, timestamp: ${img.timestamp} (${img.id})`);
                        return;
                    } else {
                        throw new Error(`Could not find image in json for imported file - ${img.filename} size: ${img.size}, timestamp: ${img.timestamp} (${img.id})`);
                    }
                }

                if (a.content[corresponding].photosId) {
                    Logger.log(`WARNING: Already have an ID for file - ${img.filename} size: ${img.size}, timestamp: ${img.timestamp} (old: ${a.content[corresponding].photosId}; new: ${img.id})`);
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

        Logger.log();
        Logger.log("Import complete! Here's what's left (basically: files that Photos thought were duplicates; you'll need to add them to albums manually.");
        Logger.log();

        // Summarize import.
        albums.forEach((a) => {
            const notImported = a.content.filter((c) => !c.photosId);

            if (notImported.length === 0) {
                Logger.log(`${a.title} => all imported.`);
            } else {
                Logger.log(`${a.title} => missing ${notImported.length}:`);
                notImported.forEach((c) => {
                    Logger.log(`\t- ${c.path}`);
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
    // Logger.log(inspect.length);
}

main();

// Logger.log(chunk([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], 3));

// const photos = [
//     {
//         image_filename: "IMG_2811.HEIC",
//         image_timestamp: 1553394810,
//         image_size: 433445,
//     }
// ];
// Logger.log(photos);
// Logger.log(findPhotoInPhotos(photos));

// Logger.log(getInfoForPhotoIds([
//     "C089130D-0123-44E3-A5C1-74F6A4D63E82/L0/001",
// ]));
