import { program } from "commander";
import { getPropertiesForPhotoWithId, getPropertiesForSelection, launchPhotosWithId } from "../src/photos_app";

program
    .argument('[media item id]', 'Photos media item ID')
    .option('-i --info', 'Get info for item')
    .action(async (media_item) => {
        if (!media_item) {
            console.log(getPropertiesForSelection());
        } else {
            if (program.opts().info) {
                console.log(getPropertiesForPhotoWithId(media_item));
            } else {
                launchPhotosWithId(media_item);
            }
        }
    });

program.parse();
