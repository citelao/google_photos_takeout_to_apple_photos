import { program } from "commander";
import { findPhotoInPhotos } from "../src/photos_app";

program
    .argument('<filename>', 'filename to find')
    .argument('<size>', 'size in bytes')
    .argument('[timestamp]', 'timestamp in seconds')
    .action(async (filename: string, size: number, timestamp: number | undefined) => {
        const result = findPhotoInPhotos([{
            image_filename: filename,
            image_size: size,
            image_timestamp: timestamp,
        }]);
        console.log(result);
    });

program.parse();
