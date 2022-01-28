import fs from "fs";
import path from "path";

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

const albums = albumFolders.map((a) => {
    const title = a.name;

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
    
    const remaining = items.filter((i) => !images_and_movies.includes(i) && !jsons.includes(i));
    if (remaining.length !== 0) {
        console.warn(`Unrecognized objects: ${remaining.map(r => r)}`);
    }

    // Ensure we have JSONs for each image/movie:
    const matched_image_and_json = images_and_movies.map((i) => {
        const json = jsons.find((j) => path.parse(j).name === path.basename(i));
        
        if (!json) {
            console.warn(`No matching JSON for ${title} - ${i}`);
        }

        return { image: i, manifest: json };
    });

    return {
        title: title,
        dirs: a.dirs,
        content: matched_image_and_json,
        items: jsons,
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
    console.log(`Total items: ${a.items.length}`);
    const noManifest = a.content.filter((c) => !c.manifest).length;
    if (noManifest) {
        console.log(`Actual images: ${a.content.length} (no manifest: ${noManifest})`);
    } else {
        console.log(`Actual images: ${a.content.length}`);
    }
    console.log();
})