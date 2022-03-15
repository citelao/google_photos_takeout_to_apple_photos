import plist, { parse } from "plist";
import { program } from "commander";
import fs from "fs";

interface IPhotoSweeperOutput {
    Results: Array<{
        Files: Array<{
            path: string;
            isMarked: boolean;

            // Beta fields
            libraryPath?: string;
            mediaItemId?: string;
        }>;
        GroupName: string;
    }>;
}

program
    .argument('<photosweeper_output>', 'plist/xml output from PhotoSweeper')
    .option("-d --do_action", "actually do stuff")
    .action(async (photosweeper_output: string) => {
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

        // Build photos => albums match
        type Matching = {
            takeoutFiles: Array<{
                path: string;
            }>;
            mediaItems: Array<{
                id: string;
            }>;
        };
        const matchings: Matching[] = parsed.Results.map((r) => {
            const mediaItems = r.Files.filter((f) => f.mediaItemId);
            const takeoutFiles = r.Files.filter((f) => !f.mediaItemId);
            return {
                takeoutFiles: takeoutFiles.map((f) => {
                    return { path: f.path };
                }),
                mediaItems: mediaItems.map((f) => {
                    if (!f.mediaItemId) {
                        throw new Error(`Unexpected no media item ID ${f}`);
                    }
                    return { id: f.mediaItemId };
                }),
            }
        });
        console.dir(matchings);
    });

program.parse();
