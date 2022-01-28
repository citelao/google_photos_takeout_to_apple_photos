import fs from "fs";
import path from "path";
import exifr from "exifr";

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
        const KNOWN_TYPES = [
            ".GIF", 
            ".HEIC",
            ".JPG",
            ".JPEG", 
            ".MOV",
            ".MP4", 
            ".PNG", 
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

        const parsedJsons = jsons.map((path) => {
            return {
                path: path,
                metadata: parseImageMetadataJson(path),
            }
        });
    
        // Ensure we have JSONs for each image/movie:
        const matched_image_and_json = await Promise.all(images_and_movies.map(async (i) => {
            const json = parsedJsons.find((j) => path.parse(j.path).name === path.basename(i));
            const quickImageName = path.basename(i);
            
            if (!json) {
                console.warn(`No matching JSON for ${title} - ${quickImageName}`);
            }

            let gps = null;
            try {
                gps = await exifr.gps(i);
            } catch(e) {
                gps = `(gps parse failed: ${e})`
            }

            const hasMetadataGeoData = json?.metadata.geoData.latitude && json?.metadata.geoData.longitude;
            const hasMetadataGeoDataExif = json?.metadata.geoDataExif.latitude && json?.metadata.geoDataExif.longitude;
            const hasGeoData = gps && typeof gps !== "string";
            if ((hasMetadataGeoData || hasMetadataGeoDataExif) && !hasGeoData) {
                console.warn(`No EXIF location data, but location metadata for ${title} - ${quickImageName}`);
            }

            return {
                image: {
                    gps: gps,
                    dir: i,
                },
                manifest: json
            };
        }));
    
        return {
            title: title,
            dirs: a.dirs,
            metadata: metadata,
            content: matched_image_and_json,
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