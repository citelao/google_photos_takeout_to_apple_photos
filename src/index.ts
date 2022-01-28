import fs from "fs";

if (process.argv.length != 3) {
    console.error(`Wrong number of arguments; try 'npm run go -- path/here/'\r\n\r\n(${process.argv})`);
    process.exit(1);
}

const takeout_dir = process.argv[2];
const files = fs.readdirSync(takeout_dir);

console.log("test", takeout_dir, files);
console.log(process.argv);