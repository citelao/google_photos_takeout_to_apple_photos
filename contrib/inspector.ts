import { program } from "commander";
import { getInfoForPhotoIds, getPropertiesForPhotoWithId, getPropertiesForSelection, launchPhotosWithId } from "../src/photos_app";

program
    .argument('[media item id]', 'Photos media item ID')
    .option('-i --info', 'Get info for item')
    .option('-n --internal', 'Get internal info for item')
    .action(async (media_item) => {
        if (!media_item) {
            console.log(getPropertiesForSelection());
        } else {
            if (program.opts().info) {
                if (program.opts().internal) {
                    console.dir(getInfoForPhotoIds([media_item]));
                } else {
                    console.log(getPropertiesForPhotoWithId(media_item));
                }
            } else {
                launchPhotosWithId(media_item);
            }
        }
    });

program.parse();
