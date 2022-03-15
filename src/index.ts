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
import { getAlbumFolders, getGooglePhotosDirsFromTakeoutDir } from "./google_takeout_dirs";

program
    .argument('<takeout_path_or_preparsed_file>', 'Google Takeout directories or parsed file')
    .option('-w --whatif', 'what if?')
    .option('-d --do_actions', 'actually perform actions, not just parse')
    .option('-a --album <album_name>', 'limit to importing a specific album')
    .option('-s --skip_albums <album_names...>', 'skip importing specific albums')
    .option('--dump --dump_parsed <output_file>', 'dump the parsed, augmented library to a file, even if reading from a file')
    .action(async (takeout_path_or_preparsed_file) => {
        const what_if: boolean = program.opts().whatif;
        const do_actions: boolean = program.opts().do_actions;
        const album: string | undefined = program.opts().album;
        const dump_parsed: string | undefined = program.opts().dump_parsed;
        const skip_albums: string[] | undefined = program.opts().skip_albums;
        await main({
            takeout_path_or_preparsed_file: takeout_path_or_preparsed_file, 
            do_actions,
            what_if,
            album,
            dump_parsed,
            skip_albums
        });
    });

program.parse();

type ManifestAndPath = {
    path: string;
    metadata: ImageMetadataJson;
};
type ContentInfo = {
    video?: {
        path: string;
        manifest?: ManifestAndPath;
        metadata: FfprobeOutput;
        livePhotoId?: string;
    };
    image?: {
        path: string;
        manifest?: ManifestAndPath;
        metadata: ExifToolOutput;
        livePhotoId?: string;
        size: number;
    }
    photosId?: string | null;
    extra: Array<{
        manifest?: ManifestAndPath;
        path: string;
        metadata: FfprobeOutput | ExifToolOutput;
        size: number | string;
    }>;
};

function isoTimestampToSeconds(timestamp?: string): number | undefined {
    if (!timestamp) {
        return undefined;
    }
    return (new Date(timestamp).getTime()) / 1000;
}

interface IImageInfo {
    image_filename: string | undefined;
    video_filename: string | undefined;
    extras: Array<{
        filename: string;
        timestamp: number | undefined;
        size: string | number | undefined;
    }>;
    image_timestamp: number | undefined;
    video_timestamp: number | undefined;
    image_size: number;
    video_size: number | undefined;
}
function getImageInfo(i: ContentInfo): IImageInfo {
    const image_filename = i.image && (i.image.manifest?.metadata.title || path.basename(i.image.path));
    const video_filename = i.video && (i.video.manifest?.metadata.title || path.basename(i.video.path));

    if (!image_filename && !video_filename) {
        throw new Error(`Missing ANY filenames for ${i.photosId}`);
    }

    const extras = i.extra.map((f) => {
        const timestamp = (isVideo(f.path))
            ? isoTimestampToSeconds((f.metadata as FfprobeOutput).format.tags["com.apple.quicktime.creationdate"] || (f.metadata as FfprobeOutput).format.tags["com.apple.quicktime.creationdate"])
            : (f.metadata as ExifToolOutput).Composite.SubSecDateTimeOriginal;
        return {
            filename: f.manifest?.metadata.title || path.basename(f.path),
            timestamp: timestamp,
            size: f.size,
        }
    });

    // Prefer creationdate; it's more accurate.
    const video_timestamp_string = i.video?.metadata.format.tags["com.apple.quicktime.creationdate"] || i.video?.metadata.format.tags.creation_time;
    const video_timestamp = isoTimestampToSeconds(video_timestamp_string);
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
        // Image title, or image path, or video title, or video path.
        image_filename: image_filename,
        video_filename: video_filename,
        image_timestamp:  i.image?.metadata.Composite.SubSecDateTimeOriginal,
        video_timestamp: video_timestamp,
        
        // Prefer image path for size, since that's what Photos uses for Live Photos.
        image_size: i.image?.size || 0, // TODO: what if no image? 
        video_size: (!!i.video?.metadata.format.size || undefined) && parseInt(i.video?.metadata.format.size!),

        extras: extras,
    };
}

type PathType = "any_but_image_first" | "image" | "video";
function getContentInfoPath(c: ContentInfo, type: PathType = "any_but_image_first") {
    const wantsImagePath = type === "image" || type === "any_but_image_first";
    if (wantsImagePath && c.image) {
        return c.image.path;
    }

    const wantsVideoPath = type === "video" || type === "any_but_image_first";
    if (wantsVideoPath && c.video) {
        return c.video.path;
    }

    throw new Error(`Could not find path for ${c} (type: ${type})`);
}

function getVideoTypes(): string[] {
    const VIDEO_TYPES = [
        ".MOV",
        ".MP4", 
        ".M4V",
    ];
    return VIDEO_TYPES;
}
function getImageTypes(): string[] {
    const IMAGE_TYPES = [
        ".GIF", 
        ".HEIC",
        ".JPG",
        ".JPEG", 
        ".PNG",
        ".NEF"
    ];
    return IMAGE_TYPES;
}
function getKnownTypes(): string[] {
    const KNOWN_TYPES = [
        ... getVideoTypes(),
        ... getImageTypes(),
    ];
    return KNOWN_TYPES;
}
function isKnownType(filename: string): boolean {
    return getKnownTypes().includes(path.extname(filename).toUpperCase());
}
function isVideo(filename: string): boolean {
    return getVideoTypes().includes(path.extname(filename).toUpperCase());
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
type ILibrary = IAlbum[];
async function parseLibrary(takeout_dir: string, album_name: string | undefined, skip_albums: string[] | undefined): Promise<ILibrary> {
    const google_photos_dirs = getGooglePhotosDirsFromTakeoutDir(takeout_dir);
    Logger.log("Reading from:", google_photos_dirs);
    
    const albumFolders = getAlbumFolders(google_photos_dirs);

    const photosAlbums = getPhotosAlbums();

    type PartsForDir = {
        images_and_movies: string[],
        albumMetadata: string | undefined,
        manifests: string[],
        remaining: string[]
    };
    const getPartsForAlbum = (album_dirs: string[]): PartsForDir => {
        const items = album_dirs.map((d) => fs.readdirSync(d).map(f => path.join(d, f)) ).flat();
        const images_and_movies = items.filter((i) => isKnownType(i));
    
        const jsons = items.filter((i) => {
            return path.extname(i) === ".json";
        });

        const metadataJsonIndex = jsons.findIndex(i => path.basename(i) === "metadata.json");
        const metadataJson = (metadataJsonIndex === -1) ? undefined : jsons.splice(metadataJsonIndex, 1)[0];
        
        const remaining = items.filter((i) => !images_and_movies.includes(i) && !jsons.includes(i) && (!metadataJson || i !== metadataJson));

        return {
            albumMetadata: metadataJson,
            images_and_movies: images_and_movies,
            manifests: jsons,
            remaining: remaining
        };
    }

    const albumParts = albumFolders.map((a) => {
        const parts = getPartsForAlbum(a.dirs);
        let metadata: AlbumMetadataJson | null = null;
        if (parts.albumMetadata) {
            metadata = parseAlbumMetadataJson(parts.albumMetadata);
        }
        const title = metadata?.title || a.name;

        return {
            // name: a.name,
            dirs: a.dirs,
            metadata: metadata,
            title: title,
            manifests: parts.manifests,
            images_and_movies: parts.images_and_movies,
            remaining: parts.remaining,
        };
    }).filter((a) => {
        // If asked to parse only certain albums, filter out the wrong albums here.
        const shouldFilterToName = !!album_name;
        if (shouldFilterToName && album_name !== a.title) {
            return false;
        }

        const shouldFilterToSkipAlbums = !!skip_albums;
        if (shouldFilterToSkipAlbums && skip_albums.includes(a.title)) {
            return false;
        }

        return true;
    });
   
    const albums = await Promise.all(albumParts.map(async (a): Promise<IAlbum> => {    
        if (a.remaining.length !== 0) {
            Logger.warn(`Unrecognized objects: \r\n${a.remaining.map(r => "\t- " + chalk.yellow(r)).join(",\r\n")}`);
        }

        const parsedJsons = a.manifests.map((p) => {
            return {
                path: p,
                metadata: parseImageMetadataJson(p),
            }
        });
    
        Logger.log(chalk.gray(`${a.title} - Getting EXIF data...`));
        const exifs = (await Promise.all(a.dirs.map(async (d) => await getExifToolDataForDirectory(d)))).flat();

        // Ensure we have JSONs for each image/movie:
        Logger.log(chalk.gray(`${a.title} - Finding manifests...`));
        const parsed_images: ContentInfo[] = [];
        for (const itemPath of a.images_and_movies) {
            const quickImageName = path.basename(itemPath);

            // First, we need to see if this a live photo.
            const isItemVideo = isVideo(itemPath)
            const metadata = (isItemVideo) ? await getFfprobeData(itemPath) : exifs.find((e) => e.SourceFile === itemPath);
            if (!metadata) {
                throw new Error(`No metadata for ${a.title} - ${quickImageName}`);
            }

            const getMatchingManifest = (): ManifestAndPath | null => {
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
                    Logger.verbose(`Using search to find truncated manifest for ${itemPath}`, noExt, ext, !!smallMatch);
                    return smallMatch || null;
                }

                return null;
            };

            const livePhotoId = (isItemVideo)
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

            const manifest = getMatchingManifest();
            if (!manifest) {
                if (existingIndex !== -1 && 
                    (parsed_images[existingIndex].image?.manifest ||  parsed_images[existingIndex].video?.manifest)) {
                    Logger.verbose(`No manifest found for ${itemPath}, but we already have one for it`);
                } else {
                    Logger.warn(`No manifest found for ${chalk.yellow(itemPath)}`);
                }
            }

            // Match GPS data
            if (manifest && !isItemVideo)
            {
                const exif = metadata as ExifToolOutput;
                const hasMetadataGeoData = manifest.metadata.geoData.latitude && manifest.metadata.geoData.longitude;
                const hasMetadataGeoDataExif = manifest.metadata.geoDataExif.latitude && manifest.metadata.geoDataExif.longitude;
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
                                lat: manifest.metadata.geoData.latitude,
                                lon: manifest.metadata.geoData.longitude
                            }, latLon);
                        const geoDataMatch = geoDataDist < GPS_PRECISION;
                        const geoDataExifDist =
                            distance({
                                lat: manifest.metadata.geoDataExif.latitude,
                                lon: manifest.metadata.geoDataExif.longitude
                            }, latLon);
                        const geoDataExifMatch = geoDataExifDist < GPS_PRECISION;
                        if (!geoDataMatch || !geoDataExifMatch) {
                            Logger.warn(`Geodata mismatch: ${a.title} - ${quickImageName} (${manifest.metadata.geoDataExif.latitude}, ${manifest.metadata.geoDataExif.longitude} [${geoDataDist}] & ${manifest.metadata.geoData.latitude}, ${manifest.metadata.geoData.longitude} [${geoDataExifDist}] => ${latLon.lat}, ${latLon.lon})`);
                        }
                    } else {
                        Logger.warn(`No EXIF location data, but location metadata for ${a.title} - ${quickImageName}`);
                    }
                } else if (hasGeoData) {
                    Logger.warn(`Has EXIF data but no location metadata ${a.title} - ${quickImageName}`);
                }
            }

            if (existingIndex !== -1) {
                const alreadyHas = (isItemVideo && parsed_images[existingIndex].video) ||
                (!isItemVideo && parsed_images[existingIndex].image);
                if (alreadyHas) {
                    // TODO: this treats edited photos like originals simply
                    // based on live photo ID.
                    const existingPath = isItemVideo 
                        ? parsed_images[existingIndex].video?.path
                        : parsed_images[existingIndex].image?.path;
                    Logger.verbose(`Redundant ${isItemVideo ? "video" : "image"} found for ${a.title} - ${quickImageName} (old: ${existingPath}, new: ${itemPath})`);

                    parsed_images[existingIndex].extra.push({
                        path: itemPath,
                        manifest: manifest || undefined,
                        metadata: metadata,
                        size: fs.statSync(itemPath).size,
                    });
                } else {
                    // Add the info to the existing image entry.
                    if (isItemVideo) {
                        parsed_images[existingIndex].video = {
                            path: itemPath,
                            manifest: manifest || undefined,
                            livePhotoId: livePhotoId,
                            metadata: metadata as FfprobeOutput
                        };
                    } else {
                        parsed_images[existingIndex].image = {
                            path: itemPath,
                            manifest: manifest || undefined,
                            livePhotoId: livePhotoId,
                            metadata: metadata as ExifToolOutput,
                            size: fs.statSync(itemPath).size,
                        };
                    }
                }
            } else {
                // Create a new image entry. Grab metadata.
                parsed_images.push({
                    image: (isItemVideo) ? undefined : {
                        path: itemPath,
                        manifest: manifest || undefined,
                        livePhotoId: livePhotoId,
                        metadata: metadata as ExifToolOutput,
                        size: fs.statSync(itemPath).size,
                    },
                    video: (!isItemVideo) ? undefined : {
                        path: itemPath,
                        manifest: manifest || undefined,
                        livePhotoId: livePhotoId,
                        metadata: metadata as FfprobeOutput,
                    },
                    extra: [],
                });
            }
        }

        const correspondingPhotosAlbum = photosAlbums.find((pa) => pa.name === a.title);
        const photosInfo = (correspondingPhotosAlbum)
            ? {
                id: correspondingPhotosAlbum.id,
                originalCount: getAlbumPhotosCount(correspondingPhotosAlbum.id)!
            }
            : null;

        return {
            title: a.title,
            existingPhotosInfo: photosInfo,
            dirs: a.dirs,
            metadata: a.metadata,
            content: parsed_images,
            manifests: parsedJsons,
        }
    }));

    // Google had a phase where all my live photos videos got transcoded into
    // separate files. I don't want them. Let's purge 'em.
    //
    // TODO: this could be unnec if we filtered by live photo ID above *across
    // all images* rather than just within each album.
    Logger.log("Deduping live photo movies...");
    albums.forEach((a, i) => {
        let filteredCount = 0;
        albums[i].content = a.content.filter((c) => {
            const livePhotoId = c.image?.livePhotoId || c.video?.livePhotoId;
            const isUnpaired = !c.image || !c.video;
            if (livePhotoId && isUnpaired) {
                // Now, do we have a *paired* live photo that matches this livePhoto id?
                const existingPair = albums.flatMap((a) => a.content).find((other_c) => {
                    const otherPhotoId = other_c.image?.livePhotoId || other_c.video?.livePhotoId;
                    const isOtherUnpaired = !other_c.image || !other_c.video;
                    if (!isOtherUnpaired && otherPhotoId) {
                        return otherPhotoId === livePhotoId;
                    }

                    return false;
                });

                if (!existingPair) {
                    // No matched pair found. Keep this photo.
                    return true;
                } else {
                    Logger.verbose(`\t\t- Filtering out ${getContentInfoPath(c)}, dupe of ${getContentInfoPath(c)} (live photo ID: ${livePhotoId})`);
                    filteredCount++;
                    return false;
                }
            }

            return true;
        });

        if (filteredCount) {
            Logger.log(chalk.gray(`\t- Filtered ${chalk.yellow(filteredCount)} redundant live photo videos from ${a.title}`));
        } else {
            Logger.verbose(chalk.gray(`\t- Nothing to filter for ${a.title}`));
        }
    });

    // Now, find IDs for all the photos in Photos!
    Logger.log("Finding existing photos in Photos app (this may take a while)...");
    albums.forEach((a) => {
        const images_to_find = a.content.map((i) => getImageInfo(i));
        Logger.log(chalk.grey(`\t${a.title} - Finding ${images_to_find.length}...`));
        const CHUNK_SIZE = 200;
        const ids = chunked(images_to_find, CHUNK_SIZE, (imgs, i, a) => {
            Logger.log(chalk.gray(`\t\tFinding ${CHUNK_SIZE} photos chunk ${i}/${a.length}...`));
            const mappedImgs = imgs.map((i) => {
                if (!i.image_filename && !i.video_filename) {
                    throw new Error(`Missing ANY filenames for (size: ${i.image_size})`);
                }

                const item = {
                    image_filename: i.image_filename || i.video_filename!,
                    image_timestamp: i.image_timestamp || i.video_timestamp,
                    image_size: i.image_size || i.video_size!,
                };
                Logger.verbose(chalk.gray(`\t\t\tLooking for ${item.image_filename} (timestamp: ${item.image_timestamp}; size: ${item.image_size})`));
                return item;
            });
            return findPhotoInPhotos(mappedImgs);
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

async function getParsedLibrary(takeout_path_or_preparsed_file: string, album_name: string | undefined, skip_albums: string[] | undefined): Promise<{ library: ILibrary; is_reading_existing_parse: boolean; }>
{
    const is_reading_existing_parse = path.extname(takeout_path_or_preparsed_file) === ".json";
    let albums: IAlbum[];
    if (is_reading_existing_parse) {
        const library_data = fs.readFileSync(takeout_path_or_preparsed_file);
        albums = JSON.parse(library_data.toString('utf-8')) as IAlbum[];

        if (album_name) {
            albums = albums.filter((a) => a.title === album_name);
        }

        if (skip_albums) {
            albums = albums.filter((a) => !skip_albums.includes(a.title));
        }
    } else {
        albums = await parseLibrary(takeout_path_or_preparsed_file, album_name, skip_albums);
    }

    return {
        library: albums,
        is_reading_existing_parse: is_reading_existing_parse,
    };
}

const RUN_PREFIX = "run-";
const CREATED_ALBUMS_JSON = "created_albums.json";
const IMPORTED_IMAGES_JSON = "imported_images.json";
type CreatedAlbum = {
    title: string,
    id: string
};
type ImportedImage = {
    photosId: string,
    mainPath: string, // Either image path or video path if no image path is present
    videoPath?: string,
    albumId: string,
};
async function getParsedLibraryAugmentedWithPreviousRuns(takeout_path_or_preparsed_file: string, album: string | undefined, skip_albums: string[] | undefined): Promise<{ library: ILibrary; is_reading_existing_parse: boolean; }>
{
    const { library, is_reading_existing_parse } = await getParsedLibrary(takeout_path_or_preparsed_file, album, skip_albums);
    const albums = library;

    // Augment this data with stuff from previous runs.
    //
    // 2 stages: albums first, then photos.
    const currentDir = fs.readdirSync(".", { withFileTypes: true });
    const previousRuns = currentDir.filter((i) => i.isDirectory() && i.name.startsWith(RUN_PREFIX));
    previousRuns.forEach((run) => {
        const albums_file = fs.readdirSync(run.name, { withFileTypes: true }).find((i) => i.isFile() && i.name === CREATED_ALBUMS_JSON);

        if (albums_file) {
            Logger.log(chalk.gray("Found albums file..."));
            const parsed_albums: CreatedAlbum[] = JSON.parse(fs.readFileSync(path.join(run.name, albums_file.name)).toString("utf8"));
            parsed_albums.forEach((pa) => {
                if (album && pa.title != album) {
                    Logger.verbose(`Ignoring album ${pa.title} since '-a ${album}' was passed.`);
                    return;
                }

                if (skip_albums && skip_albums.includes(pa.title)) {
                    Logger.verbose(`Ignoring album ${pa.title} since '-s ${skip_albums.join(", ")}' was passed.`);
                    return;
                }
                
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
                    if (album || skip_albums) {
                        Logger.verbose(`Ignoring image for album ${pi.albumId.trim()} (img: ${pi.mainPath}) since '-a ${album}' or '-s ${skip_albums?.join(", ")}' was passed.`);
                        return;
                    } else {
                        throw new Error(`Missing album for ${pi.mainPath} (wanted ${pi.albumId.trim()})`);
                    }
                }
                const correspondingPhotoIndex = albums[correspondingAlbumIndex].content.findIndex((i): boolean => {
                    return i.image?.path === pi.mainPath || i.video?.path === pi.mainPath;
                });
                if (correspondingPhotoIndex === -1) {
                    throw new Error(`Missing corresponding photo for ${pi.mainPath}, ${pi.albumId}`);
                }

                if (albums[correspondingAlbumIndex].content[correspondingPhotoIndex].photosId) {
                    throw new Error(`Already existing photo ID for album ${correspondingAlbumIndex} photo ${correspondingPhotoIndex}: (old: ${albums[correspondingAlbumIndex].content[correspondingPhotoIndex].photosId} new: ${pi.photosId})`);
                }

                Logger.verbose(`Augmenting album ${correspondingAlbumIndex} (${albums[correspondingAlbumIndex].title}) photo ${correspondingPhotoIndex} with ID: ${pi.photosId}`);
                albums[correspondingAlbumIndex].content[correspondingPhotoIndex].photosId = pi.photosId;
            });
            Logger.log(`Augmented with ${parsed_images.length} imported images from previous runs.`);
        }
    });

    return {
        library: albums,
        is_reading_existing_parse,
    };
}

async function main(
    { takeout_path_or_preparsed_file, do_actions, what_if, album, dump_parsed, skip_albums }: 
    { 
        takeout_path_or_preparsed_file: string; 
        do_actions: boolean; 
        what_if: boolean; 
        album: string | undefined;
        dump_parsed: string | undefined;
        skip_albums: string[] | undefined;
    }) {
    const { library, is_reading_existing_parse } = await getParsedLibraryAugmentedWithPreviousRuns(takeout_path_or_preparsed_file, album, skip_albums);
    const albums = library;
    Logger.log();
    
    albums.forEach((a) => {
        Logger.log(a.title);
        Logger.log(chalk.gray(`\tin: ${a.dirs.map((p) => {
            const gphotosIndex = p.indexOf("Google Photos");
            const trim = p.substring(0, gphotosIndex);
            return path.basename(trim);
        }).join(", ")}`));
        if (a.metadata) {
            Logger.log(chalk.gray("\t(has metadata)"));
        } else {
            Logger.log(chalk.red("\tNo album metadata"));
        }
        if (a.existingPhotosInfo) {
            Logger.log(chalk.gray(`\tPhotos ID: ${a.existingPhotosInfo.id}`));

            // We don't really handle existing photos well.
            if (a.existingPhotosInfo.originalCount) {
                Logger.log(`\t\tWARNING: existing photos: ${chalk.yellow(a.existingPhotosInfo.originalCount)}`);
            }
        } else {
            Logger.log(chalk.yellow(`\t(no Photos album)`));
        }
        Logger.log(chalk.gray(`\tPhoto manifests: ${chalk.green(a.manifests.length)}`));

        const livePhotoCount = a.content.filter((c) => c.image?.livePhotoId).length;
        const liveText = (livePhotoCount === 0) ? "" : ` (${chalk.green(livePhotoCount)} are live)`;

        const notImported = a.content.filter((c) => !c.photosId).length;
        const importedText = (notImported === 0) ? " (all imported)" : ` (${chalk.yellow(notImported)} not imported)`;

        const noManifest = a.content.filter((c) => (!c.video?.manifest && !c.image?.manifest)).length; // TODO: do something with this.
        const manifestText = (noManifest) ? ` (no manifest: ${chalk.yellow(noManifest)})` : "";

        Logger.log(chalk.gray(`\tActual images: ${chalk.green(a.content.length)} ${importedText}${manifestText}`));
        Logger.log();
    });

    const all_images = albums.map(a => a.content).flat();
    Logger.log(`Total images & videos: ${all_images.length}`);

    const notImported = all_images.filter((c) => !c.photosId);
    Logger.log(`Not imported: ${notImported.length}`);

    const noManifest = all_images.filter((c) => (!c.video?.manifest && !c.image?.manifest));
    Logger.log(`No manifest: ${noManifest.length}`);

    const noLocation = all_images.filter(i => i.image && !i.image.metadata.Composite.GPSLatitude);
    Logger.log(`Images with no location info: ${noLocation.length}`);

    // Unpaired Live Photos cause problems?
    const unpairedLivePhotos = all_images.filter(i => (!i.image != !i.video) && (i.image?.livePhotoId || i.video?.livePhotoId));
    Logger.log(`Unpaired live photos: ${unpairedLivePhotos.length}`);
    unpairedLivePhotos.forEach((c) => {
        Logger.verbose(`\t${getContentInfoPath(c)}`);
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
        // TODO: just care about image manifests for now.
        if (!i.image?.manifest) { return false; }

        const googleTime = parseInt(i.image?.manifest.metadata.photoTakenTime.timestamp);
        const photoTime = i.image?.metadata.Composite.SubSecDateTimeOriginal;
        if (!photoTime) {
            return false;
        }

        const timeDiff = Math.abs(googleTime - photoTime);
        return timeDiff > 2;
    });
    Logger.log(`Date mismatch: ${dateMismatch.length}`);
    dateMismatch.forEach((p) => {
        Logger.verbose(`\t-${getContentInfoPath(p)}`);
    });
    Logger.log();

    if (!is_reading_existing_parse || dump_parsed !== undefined) {
        const output_file = dump_parsed || "output.json";
        if (fs.existsSync(output_file) && !dump_parsed) {
            throw new Error(`Output file '${output_file}' exists.`)
        }
        fs.writeFileSync(output_file, JSON.stringify(albums, undefined, 4));
        Logger.log(chalk.gray(`Output to ${chalk.green(output_file)}`));
    }
    
    if (!do_actions) {
        Logger.log();
        Logger.log("Run with '-do_actions' to actually import stuff.");
    }

    // Actions
    if (do_actions) {
        const run_folder = `${RUN_PREFIX}${Logger.RUN_ID}`;
        fs.mkdirSync(run_folder);

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
        const renamedFilesDir = path.join(os.tmpdir(), "photos_import_renamed_images", Logger.RUN_ID);
        fs.mkdirSync(renamedFilesDir, { recursive: true });
        Logger.log(`\t(created dir for renamed photos: ${renamedFilesDir})`);
        albums.forEach((a) => {
            const nonImportedPhotos = a.content.filter((c) => !c.photosId);
            Logger.log(`\t- Identifying files for ${a.title}:`);
            // Don't flatten this array! If we detect live photos, we need to
            // ensure they aren't split if we chunk (below). Otherwise we will
            // generate 2 import IDs, one of which will go away when the second
            // is imported, and that will cause a ton of problems.
            const files = nonImportedPhotos.map((c): string[] => {
                const getProperFileNameAndRenameIfNecessary = (originalFilePath: string, desiredName: string | undefined): string => {
                    const currentName = path.parse(originalFilePath).name;
                    const isMisnamed = desiredName && desiredName !== currentName;
                    if (isMisnamed) {
                        Logger.log(chalk.gray(`\t\tMisnamed ${originalFilePath} (${currentName} => ${desiredName})`));
                        const ext = path.parse(originalFilePath).ext;
                        const newFilename = `${desiredName}${ext}`;
                        const destinationName = path.join(renamedFilesDir, newFilename);
                        fs.copyFileSync(originalFilePath, destinationName);
                        return destinationName;
                    } else {
                        return originalFilePath;
                    }
                };
                
                const filesForImage: string[] = [];
                const desiredImageName = c.image?.manifest && path.parse(c.image.manifest.metadata.title).name;
                if (c.image) {
                    filesForImage.push(getProperFileNameAndRenameIfNecessary(c.image.metadata.SourceFile, desiredImageName));
                }

                if (c.video) {
                    const getDesiredVideoName = (): string | undefined => {
                        if (c.extra.length >= 1 && desiredImageName) {
                            // Google has a penchant for renaming old Live Photos
                            // from:
                            //
                            // `IMG_0271.MP4` to
                            // `E3C9283E-A946-439F-B1EE-4011B3F27215_3.mov`
                            //
                            // In fact, in this case I also have a manifest-less
                            // `IMG_0271.MP4` that is identical to the mov.
                            //
                            // However, since the format is different, the Photos
                            // app will not detect a dupe (perhaps because the name
                            // is different, too?). So if our dupe-detection failed
                            // (e.g. the timestamp differed, which is what happened
                            // in this case), then we will import both again; the
                            // image will be de-duped, but this video will be
                            // imported. That's mildly annoying.
                            //
                            // To fix this, see if there's a video in extra that
                            // matches our title.
                            const matchedExtra = c.extra.find((v) => path.parse(v.path).name === desiredImageName);
                            if (matchedExtra) {
                                Logger.verbose(`Using 'extra' video ${matchedExtra.path} instead of matched video ${c.video?.path}`);
                                return path.parse(matchedExtra.path).name;
                            }
                        }
                        return c.video && c.video.manifest && path.parse(c.video.manifest.metadata.title).name;
                    };
                    const desiredVideoName = getDesiredVideoName();
                    filesForImage.push(getProperFileNameAndRenameIfNecessary(c.video.metadata.format.filename, desiredVideoName || desiredImageName));
                }

                return filesForImage;
            });
    
            Logger.log(`\t- Importing for ${a.title} (${files.length} images [${files.flat().length} a+v files] including dupes):`);
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
                const findUniquePhotoIndex = (desc: string, match_fn: (c: ContentInfo) => boolean): number => {
                    const firstCorresponding = a.content.findIndex(match_fn);
                    const findLastIndex = <T>(arr: T[], fn: (input: T) => boolean): number => {
                        const index = arr.slice().reverse().findIndex(fn);
                        if (index === -1) {
                            return index;
                        }

                        // If `0`, return end of array; if last item in array, return 0.
                        return arr.length - 1 - index;
                    };
                    const lastCorresponding = findLastIndex(a.content, match_fn);

                    if (firstCorresponding !== -1) {
                        if (firstCorresponding === lastCorresponding) {
                            Logger.verbose(`\t\t\t- Matched based on ${desc} for ${img.filename} size: ${img.size}, timestamp: ${img.timestamp} (${img.id}); index: ${firstCorresponding} (also ${lastCorresponding}). ${getContentInfoPath(a.content[lastCorresponding])}`);
                        } else {
                            Logger.warn(`\t\t\t- Multiple corresponding images found for ${img.filename} size: ${img.size}, timestamp: ${img.timestamp} (${img.id})... TODO.`);
                        }
                    }

                    return firstCorresponding;
                }

                const generate_renamed_regexp = (filename: string): RegExp => {
                    const parsed = path.parse(filename);
                    return new RegExp(`${parsed.name}\\(\\d+\\)${parsed.ext}`);
                }
                const doesImageFilenameMatch = (c: ContentInfo): boolean => {
                    const info = getImageInfo(c);
                    const photos_filename = img.filename.toUpperCase();

                    // Photos likes to rename files from `IMG_0123(1).jpg` to `IMG_0123.jpg`.
                    const image_filename_to_test = info.image_filename && info.image_filename.toUpperCase();
                    const video_filename_to_test = info.video_filename && info.video_filename.toUpperCase();
                    const extras_filenames_to_test = info.extras.map((f) => f.filename.toUpperCase());
                    const does_image_filename_match = (image_filename_to_test && image_filename_to_test === photos_filename);
                    const does_video_filename_match = (video_filename_to_test && video_filename_to_test === photos_filename) || false;
                    const does_extras_filename_match = extras_filenames_to_test.includes(photos_filename);

                    const renamed_regex = generate_renamed_regexp(photos_filename);
                    const does_renamed_image_match = (does_image_filename_match && renamed_regex.test(image_filename_to_test));
                    const does_renamed_video_match = (video_filename_to_test && renamed_regex.test(video_filename_to_test)) || false;
                    if (does_renamed_image_match || does_renamed_video_match) {
                        Logger.verbose(`\t\t\t\tMatched based on rename ('${image_filename_to_test}' or '${video_filename_to_test}' matches ${renamed_regex})`);
                    }

                    return does_image_filename_match ||
                        does_video_filename_match ||
                        does_extras_filename_match ||
                        does_renamed_image_match ||
                        does_renamed_video_match;
                }
                const doesImageSizeMatch = (c: ContentInfo): boolean => {
                    const info = getImageInfo(c);
                    return (info.image_size === img.size) || (info.video_size === img.size) || !!info.extras.find((e) => e.size === img.size);
                }
                const doesImageTimestampMatch = (c: ContentInfo): boolean => {
                    const info = getImageInfo(c);
                    // Photos seems to use FileModifyDate if the Photo has no metadata.
                    const imageTimestampMatches = ((info.image_timestamp || c.image?.metadata.File.FileModifyDate) === img.timestamp);
                    const videoTimestampMatches = info.video_timestamp === img.timestamp;
                    const extrasTimestampMatches = !!info.extras.find((e) => e.timestamp === img.timestamp);
                    return imageTimestampMatches || videoTimestampMatches || extrasTimestampMatches;
                }
                let corresponding = findUniquePhotoIndex("filename, size, & timestamp", (c) => {
                    // Man, these timestamps & sizes just *love* causing
                    // trouble. Try matching filename + size + timestamp first.
                    //
                    // Also special case for videos.
                    return doesImageFilenameMatch(c) &&
                        doesImageSizeMatch(c) &&
                        doesImageTimestampMatch(c);
                });

                // Another chance to match; Photos likes to rename some photos (especially GUID files).
                if (corresponding === -1) {
                    const size_and_timestamp_matcher = (c: ContentInfo) => {
                        return doesImageSizeMatch(c) && doesImageTimestampMatch(c);
                    }
                    corresponding = findUniquePhotoIndex("size & timestamp", size_and_timestamp_matcher);
                }

                // OK, one last chance: naive filename match.
                if (corresponding === -1) {
                    corresponding = findUniquePhotoIndex("filename only", (c) => doesImageFilenameMatch(c));
                }

                if (corresponding === -1) {
                    const hasItemsWithNoManifest = a.content.filter((c) => (!c.image?.manifest && !c.video?.manifest)).length !== 0;
                    if (hasItemsWithNoManifest) {
                        // We could simply have an item that *needs* a rename
                        // and doesn't get one because we are missing a
                        // manifest. Warn instead.
                        //
                        // TODO: we need to map the IDs; otherwise we will try
                        // to import this file again if you run again.
                        Logger.log(`WARNING: Could not find image in json for imported file - ${chalk.yellow(img.filename)} size: ${chalk.yellow(img.size)}, timestamp: ${chalk.yellow(img.timestamp)} (${chalk.yellow(img.id)})`);
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
                    mainPath: getContentInfoPath(a.content[corresponding]),
                    videoPath: a.content[corresponding].image && a.content[corresponding].video?.path, // Only populate if there's also an image path.
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
                const CHUNK_SIZE = 200;
                const images_to_find = notImported.map((i) => getImageInfo(i));
                const maybeFoundPhotos = chunked(images_to_find, CHUNK_SIZE, (imgs) => {
                    const mappedImgs = imgs.map((i) => {
                        if (!i.image_filename && !i.video_filename) {
                            throw new Error(`Missing ANY filenames for (size: ${i.image_size})`);
                        }
        
                        const item = {
                            image_filename: i.image_filename || i.video_filename!,
                            image_timestamp: undefined, // Same as beginning but use an undefined timestamp!
                            image_size: i.image_size || i.video_size!,
                        };
                        Logger.verbose(chalk.gray(`\t\t\tLooking for ${item.image_filename} (timestamp: ${item.image_timestamp}; size: ${item.image_size})`));
                        return item;
                    });
                    return findPhotoInPhotos(mappedImgs);
                });
                notImported.forEach((c, i) => {
                    const found = (maybeFoundPhotos[i])
                        ? getInfoForPhotoIds([ maybeFoundPhotos[i]! ])[0]
                        : null;
                    if (found) {
                        Logger.log(chalk.gray(`\t- ${getContentInfoPath(c)}\n\t\t${chalk.gray(`(might be ${chalk.yellow(found?.id)})`)}`));
                    } else {
                        Logger.log(`\t- ${getContentInfoPath(c)} ${chalk.gray("(no candidates found)")}`);
                    }
                });
            }
        });

        const FINAL_FILE = "final.json";
        fs.writeFileSync(FINAL_FILE, JSON.stringify(albums, undefined, 4));
        Logger.log(chalk.gray(`Wrote final status to ${chalk.green(FINAL_FILE)}`));
    }

    // const inspect = albums.slice(0, 3);
    // const inspect = albums.map(a => a.content).flat().filter(i => (!i.image != !i.video) && (i.image?.livePhotoId || i.video?.livePhotoId));
    // const inspect = albums.map(a => a.content).flat().filter(i => i.image && !i.image.metadata.Composite.GPSLatitude);
    // console.dir(inspect, { depth: 5})
    // Logger.log(inspect.length);
}

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
