import fs from "fs";
import path from "path";
import exifr from "exifr";
import util from "util";
const exec = util.promisify(require('child_process').exec);

function toFixed(n: number | string, digits: number): number {
    if (typeof n === "string") {
        n = Number.parseFloat(n);
    }
    return (n * Math.pow(10, digits)) / Math.pow(10, digits);
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
    }
}
async function getExifToolData(path: string): Promise<ExifToolOutput> {
    const PRECISION = 6;
    const result = await execAsync(`exiftool -g -json -c "%+.${PRECISION}f" "${path}"`);
    const json = JSON.parse(result.stdout)[0];
    // console.log(json);
    return json;
}

async function getExifToolDataForDirectory(dirPath: string): Promise<[ExifToolOutput]> {
    const PRECISION = 6;
    const result = await execAsync(`exiftool -g -json -c "%+.${PRECISION}f" "${dirPath}"`);
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

async function main() {
    if (process.argv.length != 3) {
        console.error(`Wrong number of arguments; try 'npm run go -- path/here/'\r\n\r\n(${process.argv})`);
        process.exit(1);
    }
    
    const takeout_dir = process.argv[2];
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
        type ContentInfo = {
            video?: {
                metadata: FfprobeOutput;
                livePhotoId?: string;
            };
            image?: {
                metadata: ExifToolOutput;
                livePhotoId?: string;
            }
            path: string;
            manifest?: {
                path: string;
                metadata: ImageMetadataJson;
            }
        };
        const matched_image_and_json = await Promise.all(images_and_movies.map(async (i): Promise<ContentInfo> => {
            const json = parsedJsons.find((j) => path.parse(j.path).name === path.basename(i));
            const quickImageName = path.basename(i);
            
            if (!json) {
                console.warn(`No matching JSON for ${title} - ${quickImageName}`);
            }

            const isVideo = VIDEO_TYPES.includes(path.extname(i));
            const metadata = (isVideo) ? await getFfprobeData(i) : exifs.find((e) => e.SourceFile === i);
            if (!metadata) {
                throw new Error(`No metadata for ${title} - ${quickImageName}`);
            }

            // Match GPS data
            if (!isVideo)
            {
                const exif = metadata as ExifToolOutput;
                const hasMetadataGeoData = json?.metadata.geoData.latitude && json?.metadata.geoData.longitude;
                const hasMetadataGeoDataExif = json?.metadata.geoDataExif.latitude && json?.metadata.geoDataExif.longitude;
                const hasGeoData = exif.Composite.GPSLatitude && exif.Composite.GPSLongitude;
                if (hasMetadataGeoData || hasMetadataGeoDataExif) {
                    if (hasGeoData) {
                        const geoDataMatch =
                            toFixed(json.metadata.geoData.latitude, 3) === toFixed(exif.Composite.GPSLatitude!, 3) &&
                            toFixed(json.metadata.geoData.longitude, 3) === toFixed(exif.Composite.GPSLongitude!, 3);
                        const geoDataExifMatch =
                            toFixed(json.metadata.geoDataExif.latitude, 3) === toFixed(exif.Composite.GPSLatitude!, 3) &&
                            toFixed(json.metadata.geoDataExif.longitude, 3) === toFixed(exif.Composite.GPSLongitude!, 3);
                        if (!geoDataMatch || !geoDataExifMatch) {
                            console.warn(`Geodata mismatch: ${title} - ${quickImageName} (${json.metadata.geoData.latitude}, ${json.metadata.geoData.longitude} => ${exif.Composite.GPSLatitude}, ${exif.Composite.GPSLongitude})`);
                        }
                    } else {
                        console.warn(`No EXIF location data, but location metadata for ${title} - ${quickImageName}`);
                    }
                } else if (hasGeoData) {
                    console.warn(`Has EXIF data but no location metadata ${title} - ${quickImageName}`);
                }
            }

            const livePhotoId = (isVideo)
                ? (metadata as FfprobeOutput).format.tags["com.apple.quicktime.content.identifier"]
                : (metadata as ExifToolOutput).MakerNotes?.ContentIdentifier;
            if (isVideo) {
                return {
                    video: {
                        metadata: metadata as FfprobeOutput,
                        livePhotoId: livePhotoId
                    },
                    path: i,
                    manifest: json
                };
            } else {
                return {
                    image: {
                        metadata: metadata as ExifToolOutput,
                        livePhotoId: livePhotoId
                    },
                    path: i,
                    manifest: json
                };
            }
        }));

        // Pair live photos
        const all_images_and_jsons = matched_image_and_json.reduce<ContentInfo[]>((acc, cur) => {
            const livePhotoId = (cur.image) ? cur.image.livePhotoId : cur.video?.livePhotoId;
            if (livePhotoId) {
                const existingIndex = acc.findIndex((c) => {
                    if (c.image) {
                        return c.image.livePhotoId === livePhotoId;
                    } else {
                        return c.video!.livePhotoId === livePhotoId;
                    }
                });
                if (existingIndex !== -1) {
                    if (cur.image) {
                        acc[existingIndex].image = cur.image;
                    } else {
                        acc[existingIndex].video = cur.video;
                    }
                }
            } else {
                acc.push(cur);
            }
            return acc;
        }, []);
    
        return {
            title: title,
            dirs: a.dirs,
            metadata: metadata,
            content: all_images_and_jsons,
            items: parsedJsons,
        }
    }));
    
    // console.log(JSON.stringify(albums, null, 2));

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
        console.log(`\tTotal items: ${a.items.length}`);
        const noManifest = a.content.filter((c) => !c.manifest).length;
        if (noManifest) {
            console.log(`\tActual images: ${a.content.length} (no manifest: ${noManifest})`);
        } else {
            console.log(`\tActual images: ${a.content.length}`);
        }
        console.log();
    })
}

main();