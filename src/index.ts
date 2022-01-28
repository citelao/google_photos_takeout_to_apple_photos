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

const albums = google_photos_dirs.map((d) => {
    const files = fs.readdirSync(d, { withFileTypes: true });
    const dirs = files.filter((f)=> f.isDirectory());
    const full_dirs = dirs.map((f) => path.join(d, f.name));
    return full_dirs;
}).flat();
console.log(albums);