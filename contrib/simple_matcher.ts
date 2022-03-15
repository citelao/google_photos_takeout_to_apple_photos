import fs from "fs";
import path from "path";

import chalk from "chalk";
import plist from "plist";
import { program } from "commander";

import { getAlbumFolders, getGooglePhotosDirsFromTakeoutDir } from "../src/google_takeout_dirs";
import { parseAlbumMetadataJson } from "../src/google_manifests";
import Logger from "../src/Logger";

interface IPhotoSweeperFile {
    path: string;
    isMarked: boolean;

    // Beta fields
    libraryPath?: string;
    mediaItemId?: string;
}
interface IPhotoSweeperOutput {
    Results: Array<{
        Files: Array<IPhotoSweeperFile>;
        GroupName: string;
    }>;
}

function isPhotoLibraryPhoto(file: IPhotoSweeperFile): boolean {
    if (!!file.mediaItemId) {
        return true;
    }

    // TODO: by default, media item ID is not available in the XML. Use a
    // heuristic.
    return file.path.includes(".photoslibrary");
}

program
    .argument('<photosweeper_output>', 'plist/xml output from PhotoSweeper')
    .argument('<takeout_dir>', 'base takeout dir (that has all the subtakeouts)')
    .option("-d --do_action", "actually do stuff")
    .action(async (photosweeper_output: string, takeout_dir: string) => {
        const do_action: boolean = program.opts().do_action;

        const content = fs.readFileSync(photosweeper_output);
        const parsed = plist.parse(content.toString("utf8")) as any as IPhotoSweeperOutput;

        // Ensure all libraries are the same.
        const libraryPaths = parsed.Results
            .flatMap((r) => r.Files.map((f) => f.mediaItemId));
        // https://stackoverflow.com/questions/1960473/get-all-unique-values-in-a-javascript-array-remove-duplicates
        const dedupedLibraryPaths = libraryPaths
            .filter((libraryPath, index, self) => self.indexOf(libraryPath) === index);
        if (dedupedLibraryPaths.length > 1) {
            throw new Error(`Multiple photo libraries detected (${dedupedLibraryPaths})`);
        }

        // Get a list of albums.
        const googleTakeoutAlbums = getAlbumFolders(getGooglePhotosDirsFromTakeoutDir(takeout_dir));
        const albums = googleTakeoutAlbums.map((albumFolder) => {
            const items = albumFolder.dirs.flatMap((d) => fs.readdirSync(d).map(f => path.join(d, f)) );
            const metadataJson = items.find(i => path.basename(i) === "metadata.json");
            const metadata = (metadataJson) ? parseAlbumMetadataJson(metadataJson) : null;

            return {
                title: metadata?.title || albumFolder.name,
                dirs: albumFolder.dirs
            };
        });

        // Build photos => albums match
        type Matching = {
            groupName: string;
            takeoutFiles: Array<{
                path: string;
            }>;
            mediaItems: Array<{
                id?: string; 
                path: string;
            }>;
        };
        const matchings: Matching[] = parsed.Results.map((r) => {
            const mediaItems = r.Files.filter((f) => isPhotoLibraryPhoto(f));
            const takeoutFiles = r.Files.filter((f) => !isPhotoLibraryPhoto(f));
            return {
                takeoutFiles: takeoutFiles.map((f) => {
                    return { path: f.path };
                }),
                mediaItems: mediaItems.map((f) => {
                    // TODO:  don't always have an ID.
                    //
                    // if (!f.mediaItemId) {
                    //     throw new Error(`Unexpected no media item ID ${f}`);
                    // }
                    return {
                        id: f.mediaItemId,
                        path: f.path
                    };
                }),
                groupName: r.GroupName,
            }
        });
        // console.dir(matchings);

        const getAlbumTitle = (file_path: string): string | null => {
            const matchedAlbum = albums.find((a) => a.dirs.findIndex((d) => d.startsWith(path.dirname(file_path))) !== -1);
            if (!matchedAlbum) {
                Logger.warn(chalk.yellow(`No matched album for ${file_path}`));
                return null;
            }
            return matchedAlbum.title;
        }
        const matchedToAlbums = matchings.map((m) => {
            // if (m.mediaItems.length > 1) {
            //     throw new Error(`${m.groupName} - Too many media items for item ${m.mediaItems[0].path} (apple photos: ${m.mediaItems.length}; takeout files: ${m.takeoutFiles.length})`);
            // }

            const potentialAlbumTitles = m.takeoutFiles
                .map((f) => getAlbumTitle(f.path))
                .filter((f) => !!f) as string[];
            let albumTitle: string | null = null;
            switch(potentialAlbumTitles.length) {
                case 0:
                    // throw new Error(`No album title for ${m.groupName}`);
                    break;

                case 1:
                    albumTitle = potentialAlbumTitles[0];
                    break;
                
                default:
                    {
                        const firstGoodTitle = potentialAlbumTitles.find((t) => !t.startsWith("Photos from "));
                        if (firstGoodTitle)
                        {
                            albumTitle = firstGoodTitle;
                        } else {
                            Logger.warn(chalk.yellow(`Multiple good albums found for ${m.groupName} (${potentialAlbumTitles}). Choosing the first.`))
                            albumTitle = potentialAlbumTitles[0];
                        }
                        break;
                    }
            }

            return {
                album: albumTitle,
                matching: m,
            };
        });

        const itemsByAlbums = matchedToAlbums.reduce<Array<{ title: string | null; matching: Matching[]; }>>((acc, m) => {
            const existingIndex = acc.findIndex((i) => m.album === i.title);
            if (existingIndex === -1) {
                acc.push({
                    title: m.album,
                    matching: [ m.matching ]
                });
            } else {
                acc[existingIndex].matching.push(m.matching);
            }
            return acc;
        }, []);

        console.dir(itemsByAlbums);
    });

program.parse();
