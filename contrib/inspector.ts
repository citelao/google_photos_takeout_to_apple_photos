import { program } from "commander";
import { launchPhotosWithId } from "../src/photos_app";

program
    .argument('<media item id>', 'Photos media item ID')
    // .option('-i --info', 'Get info for item')
    .action(async (media_item) => {
        launchPhotosWithId(media_item);
    });

program.parse();
