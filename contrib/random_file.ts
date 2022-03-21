import { program } from "commander";
import { parseAlbumMetadataJson } from "../src/google_manifests";
import { getAlbumFolders, getGooglePhotosDirsFromTakeoutDir, getPartsForAlbum } from "../src/google_takeout_dirs";
import crypto from "crypto";

program
    .argument('<google_takeout_dir>', 'google takeout dir')
    .argument('<n>', 'number to find')
    .action(async (google_takeout_dir: string, n: number) => {
        // Get a list of albums.
        const googleTakeoutAlbums = getAlbumFolders(getGooglePhotosDirsFromTakeoutDir(google_takeout_dir));
        type Album = {
            title: string;
            dirs: string[];
            images_and_movies: string[];
            manifests: string[];
            remaining: string[]
        };
        const albums = googleTakeoutAlbums.map((albumFolder): Album => {
            const parts = getPartsForAlbum(albumFolder.dirs);
            const metadataJson = parts.albumMetadata;
            const metadata = (metadataJson) ? parseAlbumMetadataJson(metadataJson) : null;

            return {
                title: metadata?.title || albumFolder.name,
                dirs: albumFolder.dirs,
                images_and_movies: parts.images_and_movies,
                manifests: parts.manifests,
                remaining: parts.remaining,
            };
        });

        const all_images = albums.flatMap((a) => a.images_and_movies);

        const indeces: number[] = [];
        for (let index = 0; index < n; index++) {
            let i = crypto.randomInt(0, all_images.length);
            while (indeces.includes(n)) {
                i = crypto.randomInt(0, all_images.length);
            }
            
            indeces.push(i);
        }
        console.log(indeces.map((i) => all_images[i]));
    });

program.parse();
