import fs from "fs";
import path from "path";

import chalk from "chalk";
import plist from "plist";
import { program } from "commander";

import { getAlbumFolders, getGooglePhotosDirsFromTakeoutDir, getPartsForAlbum } from "../src/google_takeout_dirs";
import { parseAlbumMetadataJson } from "../src/google_manifests";
import Logger from "../src/Logger";
import { addPhotosToAlbumIfMissing } from "../src/photos_app";
import { ContentIdentifiersOutput, getContentIdentifiersForDirectory } from "../src/image_data";
import { isVideo } from "../src/known_types";

interface IPhotoSweeperFile {
    path: string;
    isMarked: boolean;

    // Beta fields
    libraryPath?: string;
    mediaItemID?: string;
}
interface IPhotoSweeperOutput {
    Results: Array<{
        Files: Array<IPhotoSweeperFile>;
        GroupName: string;
    }>;
}

function isPhotoLibraryPhoto(file: IPhotoSweeperFile, loose = true): boolean {
    if (!!file.mediaItemID) {
        return true;
    }

    if (loose) {
        // TODO: by default, media item ID is not available in the XML. Use a
        // heuristic.
        return file.path.includes(".photoslibrary");
    }

    return false;
}

program
    .argument('<photosweeper_output>', 'plist/xml output from PhotoSweeper')
    .argument('<takeout_dir>', 'base takeout dir (that has all the subtakeouts)')
    .argument('[content_identifiers_json]', 'JSON file with mapping of filenames to Live Photo content identifiers (will generate if not provided)')
    .option("-d --do_action", "actually do stuff")
    .option("-m --missing", "dump missing (non-imported) images")
    .option("-l --loose", "be loose with matching (don't require media item IDs)")
    .option("--no_pair_live_photos", "skip pairing live photos")
    .option("-w --what_if", "what if?")
    .action(async (photosweeper_output: string, takeout_dir: string, content_identifiers_json: string | undefined) => {
        const do_action: boolean = program.opts().do_action;
        const missing: boolean = program.opts().missing;
        const loose: boolean = program.opts().loose;
        const no_pair_live_photos: boolean = program.opts().no_pair_live_photos;
        const pair_live_photos = !no_pair_live_photos;
        const what_if: boolean = program.opts().what_if;

        const content = fs.readFileSync(photosweeper_output);
        const parsed = plist.parse(content.toString("utf8")) as any as IPhotoSweeperOutput;

        // Ensure all libraries are the same.
        const libraryPaths = parsed.Results
            .flatMap((r) => r.Files.map((f) => f.libraryPath))
            .filter((p) => !!p);
        // https://stackoverflow.com/questions/1960473/get-all-unique-values-in-a-javascript-array-remove-duplicates
        const dedupedLibraryPaths = libraryPaths
            .filter((libraryPath, index, self) => self.indexOf(libraryPath) === index);
        if (dedupedLibraryPaths.length > 1) {
            throw new Error(`Multiple photo libraries detected (${dedupedLibraryPaths})`);
        }

        // Get a list of albums.
        const googleTakeoutAlbums = getAlbumFolders(getGooglePhotosDirsFromTakeoutDir(takeout_dir));
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

        const getAlbumTitle = (file_path: string): string | null => {
            const matchedAlbum = albums.find((a) => a.dirs.findIndex((d) => d.startsWith(path.dirname(file_path))) !== -1);
            if (!matchedAlbum) {
                Logger.warn(chalk.yellow(`No matched album for ${file_path}`));
                return null;
            }
            return matchedAlbum.title;
        }
        const isGoodTitle = (title: string): boolean => {
            return !title.startsWith("Photos from ");
        }

        // Pair live photos if asked.
        let sourceFileToContentIdsMap = new Map<string, string | null>();
        let contentIdToSourceImageMap = new Map<string, string[]>();
        if (pair_live_photos)
        {
            let ids: ContentIdentifiersOutput[] = [];
            if (content_identifiers_json)
            {
                const library_data = fs.readFileSync(content_identifiers_json);
                ids = JSON.parse(library_data.toString('utf-8')) as ContentIdentifiersOutput[];
            } else {
                const allAlbumDirs = new Set(albums.flatMap((a) => a.dirs));
    
                // Be crafty---"Google Photos" dirs are probably the ones we want to iterate.
                const albumDirsToIterate = new Set<string>();
                for (let dir of allAlbumDirs) {
                    const basedir = path.dirname(dir);
                    if (path.basename(basedir) === "Google Photos") {
                        albumDirsToIterate.add(basedir);
                    } else {
                        albumDirsToIterate.add(dir);
                    }
                }
    
                Logger.log(chalk.gray(`Getting live photo information (pass content_identifiers_json in future runs to speed this up)...`));
                let index = 1;
                for (let dir of albumDirsToIterate) {
                    Logger.log(chalk.gray(`\t- (${chalk.white(`${index++} of ${albumDirsToIterate.size}`)}) Enumerating ${dir}`));
                    ids.push(...(await getContentIdentifiersForDirectory(dir)));
                }

                const output_file = "content_identifiers.json";
                const file = Logger.getFileOrFallbackTemporaryFile(output_file);
                fs.writeFileSync(file, JSON.stringify(ids, undefined, 4));
                Logger.log(chalk.gray(`Output to ${chalk.green(file)}`));
            }

            ids.forEach((i) => {
                if (sourceFileToContentIdsMap.has(i.SourceFile)) {
                    throw new Error(`Already have ID ${sourceFileToContentIdsMap.get(i.SourceFile)} for ${i.SourceFile} (want to set to ${i.ContentIdentifier})`);
                }
                sourceFileToContentIdsMap.set(i.SourceFile, i.ContentIdentifier || null);

                if (i.ContentIdentifier) {
                    if (!isVideo(i.SourceFile)) {
                        const existingFiles = contentIdToSourceImageMap.get(i.ContentIdentifier) || [];
                        contentIdToSourceImageMap.set(i.ContentIdentifier, [...existingFiles, i.SourceFile]);
                    }
                }
            });
        }

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
            const mediaItems = r.Files.filter((f) => isPhotoLibraryPhoto(f, loose));
            const takeoutFiles = r.Files.filter((f) => !isPhotoLibraryPhoto(f, loose));
            return {
                takeoutFiles: takeoutFiles.map((f) => {
                    return { path: f.path };
                }),
                mediaItems: mediaItems.map((f) => {
                    if (!loose && !f.mediaItemID) {
                        throw new Error(`Unexpected no media item ID ${r.GroupName} ${f.path}`);
                    }
                    return {
                        id: f.mediaItemID,
                        path: f.path
                    };
                }),
                groupName: r.GroupName,
            }
        });
        // console.dir(matchings);

        const matchedToAlbums = matchings.flatMap((m) => {
            // if (m.mediaItems.length > 1) {
            //     throw new Error(`${m.groupName} - Too many media items for item ${m.mediaItems[0].path} (apple photos: ${m.mediaItems.length}; takeout files: ${m.takeoutFiles.length})`);
            // }

            const albumTitles = m.takeoutFiles
                .map((f) => getAlbumTitle(f.path))
                .filter((f) => !!f) as string[];
            
            return albumTitles.map((t) => {
                return {
                    album: t,
                    matching: m,
                };
            });
        });

        const itemsByAlbums = matchedToAlbums.reduce<Array<{ title: string | null; album: Album; matching: Matching[]; }>>((acc, m) => {
            const existingIndex = acc.findIndex((i) => m.album === i.title);
            if (existingIndex === -1) {
                acc.push({
                    title: m.album,
                    album: albums.find((a) => a.title === m.album)!,
                    matching: [ m.matching ],
                });
            } else {
                acc[existingIndex].matching.push(m.matching);
            }
            return acc;
        }, []);

        // https://stackoverflow.com/questions/51165/how-to-sort-strings-in-javascript
        itemsByAlbums.sort((a, b) => {
            return (a.title || "").localeCompare(b.title || ""); 
        });

        type AlbumDuped = {
            title: string | null;

            importedFiles: Array<{ matching: Matching; pairedLivePhoto?: { files: string[]; contentId: string; } }>;
            unimportedFiles: string[];
            remainingFiles: string[];
        };
        const itemsByAlbumsWithMissing = itemsByAlbums.map((a): AlbumDuped => {
            // Logger.log(a.album.images_and_movies);

            let albumImagesAndVideosWithLivePhotosCleaned = [];
            let baseFileToLivePhotosMap = new Map<string, { files: string[]; contentId: string; }>();
            if (pair_live_photos) {
                for (let p of a.album.images_and_movies) {
                    if (isVideo(p)) {
                        // Only try to match videos to images, since we expect
                        // images might be edited (but who's editing a video?)
                        const contentId = sourceFileToContentIdsMap.get(p)
                        if (contentId) {
                            const matchedSourceFile = contentIdToSourceImageMap.get(contentId);
                            if (matchedSourceFile) {
                                matchedSourceFile.forEach((matched) => {
                                    const base = baseFileToLivePhotosMap.get(matched) || { files: [], contentId: contentId};
                                    base.files.push(p);
                                    baseFileToLivePhotosMap.set(matched, base);
                                });
                                continue;
                            }
                        }
                    }

                    albumImagesAndVideosWithLivePhotosCleaned.push(p);
                }
            } else {
                albumImagesAndVideosWithLivePhotosCleaned = a.album.images_and_movies;
            }

            // Logger.log(albumImagesAndVideosWithLivePhotosCleaned);

            const matchingsInProgress = [...a.matching];
            const files = albumImagesAndVideosWithLivePhotosCleaned.map((i) => {
                const matchIndex = a.matching.findIndex((m) => m.takeoutFiles.findIndex((f) => f.path === i) !== -1);
                const matchInProgressIndex = matchingsInProgress.findIndex((m) => m.takeoutFiles.findIndex((f) => f.path === i) !== -1);
                if (matchInProgressIndex !== -1) {
                    matchingsInProgress.splice(matchInProgressIndex, 1);
                }
                const match = a.matching[matchIndex];
                const pairedLivePhoto = baseFileToLivePhotosMap.get(i);
                
                return {
                    file: i,
                    match: match,
                    pairedLivePhoto: pairedLivePhoto
                };
            });
            if (matchingsInProgress.length !== 0) {
                Logger.warn(`Remaining matchings: ${JSON.stringify(matchingsInProgress, undefined, 4)}`);
            }
            const importedFiles = files.filter((f) => f.match).map((f) => {
                return {
                    matching: f.match!,
                    pairedLivePhoto: f.pairedLivePhoto
                };
            });
            const unimportedFiles = files.filter((f) => !f.match).map((f) => f.file);
            // Logger.log(importedFiles);
            // Logger.log(unimportedFiles);

            return {
                title: a.title,
                importedFiles: importedFiles,
                unimportedFiles: unimportedFiles,
                remainingFiles: a.album.remaining,
            }
        });

        Logger.log(`Albums found:`);
        itemsByAlbumsWithMissing.forEach((a) => {
            const allImages = [...a.importedFiles.flatMap((i) => i.matching.takeoutFiles[0].path), ...a.unimportedFiles];
            const allFiles = [...allImages, ...a.remainingFiles];

            const allImported = a.unimportedFiles.length === 0;
            if (allImported) {
                Logger.log(`\t- ${chalk.green(a.title) || chalk.grey("(null)")} ${chalk.gray(`(all ${a.importedFiles.length} items in Photos)`)}`);
            } else {
                Logger.log(`\t- ${a.title || chalk.grey("(null)")} ${chalk.gray(`(${chalk.white(a.importedFiles.length)}/${allImages.length} items in Photos)`)}`);
                // Logger.log(`\t\t${a.unimportedFiles.slice(0, 5)}`)
            }
            
            if (a.remainingFiles.length > 0) {
                Logger.log(`\t\t=> + ${chalk.yellow(a.remainingFiles.length)} extra files`);
            }

            const totalWithContentIdLookup = allImages.filter((f) => {
                return sourceFileToContentIdsMap.has(f);
            });
            if (totalWithContentIdLookup.length !== allImages.length) {
                Logger.log(chalk.yellow(`\t\t=> Only know content ID status for ${totalWithContentIdLookup.length}.`));
            }

            if (pair_live_photos) {
                const livePhotos = a.importedFiles.filter((i) => i.pairedLivePhoto);
                const baseFileCount = a.importedFiles.reduce((acc, i) => {
                    return acc + i.matching.takeoutFiles.length + (i.pairedLivePhoto?.files.length || 0);
                }, 0);
                if (livePhotos.length !== 0) {
                    Logger.log(chalk.grey(`\t\t=> ${livePhotos.length} live photos found from ${baseFileCount} base files`));
                }

                // TODO: match to figure out dupes
                // const totalWithActualContentId = a.matching.filter((m) => {
                //     return !!m.takeoutFiles.find((f) => sourceFileToContentIdsMap.has(f.path) && sourceFileToContentIdsMap.get(f.path) !== null);
                // });
                // if (totalWithActualContentId.length > 0) {
                //     Logger.log(`\t\t=> ${totalWithActualContentId.length} with content ID`);
                // }    
            }

            const missingPhotoId = a.importedFiles.filter((i) => {
                return (i.matching.mediaItems.length === 0);
            });
            if (missingPhotoId.length > 0) {
                Logger.log(`\t\t=> ${missingPhotoId.length} missing photo ID`);
            }
        });


        // MISSING
        const unimported = itemsByAlbumsWithMissing.flatMap((a) => {
            return a.unimportedFiles;
        });
        const remaining = itemsByAlbumsWithMissing.flatMap((a) => a.remainingFiles);
        
        if (missing) {
            Logger.log(`Unimported images:`);

            unimported.sort((a, b) => {
                return a.localeCompare(b); 
            });

            remaining.sort((a, b) => {
                return a.localeCompare(b); 
            });

            Logger.log(unimported);
            Logger.log(remaining);
        }

        Logger.log(`Some stats:`);
        if (unimported.length > 0) {
            Logger.log(`\t Unimported images: ${chalk.yellow(unimported.length)}`);
            Logger.log(`\t Unknown files: ${chalk.yellow(remaining.length)}`);
        }

        if (!missing) {
            Logger.log(`Use -m to --missing to dump missing images`);
        } 

        if (!do_action) {
            Logger.log(`Use -d or --do_action to actually add the items to albums.`);
            return;
        }

        // DO THE WORK!
        Logger.log(`Adding items to album:`);
        itemsByAlbumsWithMissing.forEach((a) => {
            if (!a.title) {
                Logger.log(`\t- Skipping album with no name`);
                return;
            }
            const ids = a.importedFiles.flatMap((i) => i.matching.mediaItems.map((i) => i.id)).filter((i) => !!i) as string[];
            const added = addPhotosToAlbumIfMissing(a.title, ids, what_if);

            const expectedAdded = ids.length;
            if (added != expectedAdded) {
                Logger.log(`\t- Added ${added} items to ${a.title} (${chalk.yellow(`expected ${expectedAdded}`)})`);
            } else {
                Logger.log(`\t- Added ${added} items to ${a.title}`);
            }
        });
    });

program.parse();
