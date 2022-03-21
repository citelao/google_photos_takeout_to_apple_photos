import chalk from "chalk";
import child_process from "child_process";
import Logger from "./Logger";

export function getPhotosAlbums() {
    // This was originally nested, but it's really annoying to deal with nested
    // albums, so I'm not going to. I don't have them anyway.

//     const GET_ALBUMS_NESTED_SCRIPT = `
// on listContainer(cs)
// 	set res to ""
// 	repeat with c in cs
// 		set res to res & "
// " & name of c & ", " & id of c
// 		if class of c is "container" then
// 			set childs to my listContainer(containers of c)
// 			set res to res & childs
// 		end if
// 	end repeat
	
// 	return res
// end listContainer

// tell application "Photos"
// 	my listContainer(containers)
// end tell
// `;
    const GET_ALBUMS_SCRIPT = `
on listContainer(cs)
	set res to ""
	repeat with c in cs
		set res to res & "
" & name of c & ", " & id of c
	end repeat
	
	return res
end listContainer

tell application "Photos"
	my listContainer(containers)
end tell
`;
    const result = child_process.spawnSync("osascript", ["-"], { input: GET_ALBUMS_SCRIPT});
    const output = result.stdout.toString("utf-8");
    if (result.stderr.length != 0) {
        throw new Error(result.stderr.toString("utf-8"));
    }
    const lines = output.split("\n").filter((l) => l.length > 1);
    // Logger.log(lines);
    const albums = lines.map((l) => {
        const pts = l.split(", ");
        return {
            name: pts[0],
            id: pts[1]
        };
    });

    return albums;
}

export function findPhotoInPhotos(images: {image_filename: string, image_timestamp?: number | string , image_size?: number}[]): (string | null)[] {
    // Derived from https://github.com/akhudek/google-photos-to-apple-photos/blob/main/migrate-albums.py
    const DIVIDER = "✂";
    const TIMESTAMP_TOLERANCE = "2";
    const FIND_PHOTO_SCRIPT = `
        on unixDate(datetime)
            set command to "date -j -f '%A, %B %e, %Y at %I:%M:%S %p' '" & datetime & "'"
            set command to command & " +%s"
            
            set theUnixDate to do shell script command
            return theUnixDate
        end unixDate

        on tryGetImage(image_filename, image_timestamp, image_size)
            tell application "Photos"
                set images to search for image_filename

                repeat with img in images
                    set myFilename to filename of img
                    set myTimestamp to my unixDate(get date of img)
                    set mySize to size of img                
                    if image_filename is equal to myFilename and ((image_size is equal to "") or mySize is equal to (image_size as integer))
                        if image_timestamp is equal to ""
                            return (get id of img)
                        end if

                        set time_diff to image_timestamp - myTimestamp
                        if time_diff < 0 then
                            set abs_time_diff to -time_diff
                        else
                            set abs_time_diff to time_diff
                        end if

                        if abs_time_diff <= ${TIMESTAMP_TOLERANCE} then
                            return (get id of img)
                        end if
                    end if
                end repeat

                return ""
            end tell
        end tryGetImage

        on run argv
            set output to ""
            set currentIndex to 1
            repeat while currentIndex <= length of argv
                set image_filename to item currentIndex of argv
                set image_timestamp to item (currentIndex + 1) of argv 
                set image_size to item (currentIndex + 2) of argv
                set output to output & (my tryGetImage(image_filename, image_timestamp, image_size)) & "${DIVIDER}"
                set currentIndex to currentIndex + 3
            end repeat

            return output
        end run
    `;
    const flatArgs = images.map((i) => [i.image_filename, (i.image_timestamp || "").toString(), (i.image_size || "").toString()]).flat();
    const result = child_process.spawnSync("osascript", ["-", ... flatArgs], { input: FIND_PHOTO_SCRIPT});
    const output = result.stdout.toString("utf-8");
    if (result.stderr.length != 0) {
        throw new Error(result.stderr.toString("utf-8"));
    }
    const ids = output.split(DIVIDER);
    ids.pop(); // The last one is always that extra scissor.
    return ids.map((i) => i.trim() || null);
}

export function findOrCreateAlbum(title: string) {
    // Derived from https://github.com/akhudek/google-photos-to-apple-photos/blob/main/migrate-albums.py
    const SCRIPT = `
        on run argv
            tell application "Photos"
                set album_name to item 1 of argv
                if (exists album named album_name) then
                    set a to album named album_name
                else
                    set a to make new album named album_name
                end if
                
                return id of a
            end tell
        end run
    `;
    const result = child_process.spawnSync("osascript", ["-", title], { input: SCRIPT });
    const output = result.stdout.toString("utf-8");
    if (result.stderr.length != 0) {
        throw new Error(result.stderr.toString("utf-8"));
    }
    return output.trim();
}

export function launchPhotosWithId(media_item_id: string) {
    const SCRIPT = `
        on run argv
            tell application "Photos"
                set media_item_id to item 1 of argv
                set img to media item id media_item_id
                -- properties of img
                spotlight img
                activate window
            end tell
        end run
    `;
    const result = child_process.spawnSync("osascript", ["-", media_item_id], { input: SCRIPT });
    const output = result.stdout.toString("utf-8");
    if (result.stderr.length != 0) {
        throw new Error(result.stderr.toString("utf-8"));
    }
}

export function getPropertiesForPhotoWithId(media_item_id: string) {
    const SCRIPT = `
        on run argv
            tell application "Photos"
                set media_item_id to item 1 of argv
                set img to media item id media_item_id
                properties of img
            end tell
        end run
    `;
    const result = child_process.spawnSync("osascript", ["-", media_item_id], { input: SCRIPT });
    const output = result.stdout.toString("utf-8");
    if (result.stderr.length != 0) {
        throw new Error(result.stderr.toString("utf-8"));
    }

    return output;
}


export function getPropertiesForSelection() {
    const SCRIPT = `
        on run argv
            tell application "Photos"
                set img to item 1 of (get selection)
                properties of img
            end tell
        end run
    `;
    const result = child_process.spawnSync("osascript", ["-"], { input: SCRIPT });
    const output = result.stdout.toString("utf-8");
    if (result.stderr.length != 0) {
        throw new Error(result.stderr.toString("utf-8"));
    }

    return output;
}

export function getAlbumPhotosCount(album_id: string) {
    // Derived from https://github.com/akhudek/google-photos-to-apple-photos/blob/main/migrate-albums.py
    const NOT_FOUND = "NOT FOUND";
    const SCRIPT = `
        on run argv
            tell application "Photos"
                set album_id to item 1 of argv
                if (exists album id album_id) then
                    set a to album id album_id
                    return count of media item in a
                else
                    return "${NOT_FOUND}"
                end if
            end tell
        end run
    `;
    const result = child_process.spawnSync("osascript", ["-", album_id], { input: SCRIPT });
    const output = result.stdout.toString("utf-8");
    if (result.stderr.length != 0) {
        throw new Error(result.stderr.toString("utf-8"));
    }

    if (output === NOT_FOUND) {
        return null;
    }

    return parseInt(output);
}

export function addPhotosToAlbumIfMissing(album_name: string, photoIds: string[], what_if: boolean): number {
    if (photoIds.length === 0) {
        Logger.log(`\tSkipping ${album_name} - no photos to add.`);
        return 0;
    }

    // Just concatenate the ids for ease of editing. The album_name is still
    // passed in as an arg to get it escaped nicely.
    const script = `
        on run argv
            tell application "Photos"
                set album_name to item 1 of argv
                if (exists album named album_name) then
                    set a to album named album_name
                else
                    set a to make new album named album_name
                end if
                
                set originalCount to count of media item in a
                add {${photoIds.map((i) => `media item id "${i}"`).join(", ")}} to a
                set finalCount to count of media item in a
                return finalCount - originalCount
            end tell
        end run
    `;

    if (what_if) {
        Logger.log(script);
        return 0;
    } else {
        const result = child_process.spawnSync("osascript", ["-", album_name], { input: script });
        const output = result.stdout.toString("utf-8");
        if (result.stderr.length != 0) {
            throw new Error(result.stderr.toString("utf-8"));
        }

        const addedCount = parseInt(output);
        return addedCount;
    }
}

function chunk<T>(array: T[], chunk_size: number): T[][]
{
    let output: T[][] = [];
    let laggingIndex = 0;
    while (laggingIndex < array.length) {
        const top = Math.min(array.length, laggingIndex + chunk_size);
        output.push(array.slice(laggingIndex, top));
        laggingIndex += chunk_size;
    }
    return output;
}

export function chunked<T, O>(array: T[], chunk_size: number, fn: (input: T[], i: number, array: T[][]) => O[]): O[]
{
    return chunk(array, chunk_size).flatMap(fn);
}

function restartPhotos(what_if: boolean) {
    const script = `
    tell application "Photos"
        quit
        activate
    end tell
    `;
    if (what_if) {
        Logger.log(script);
        return [];
    } else {
        child_process.spawnSync("osascript", ["-"], { input: script });
    }
}

export function importPhotosToAlbumChunked(album_name: string, UNSAFE_files_ESCAPE_THESE: string[], what_if: boolean) {
    const CHUNK_SIZE = 200;
    const RESTART_EVERY = 2000;
    let lastRestart = 0;
    return chunked(UNSAFE_files_ESCAPE_THESE, CHUNK_SIZE, (files, i, a) => {
        if ((i * CHUNK_SIZE) - lastRestart > RESTART_EVERY) {
            lastRestart = i * CHUNK_SIZE;
            Logger.log(chalk.gray(`\t\tRestarting photos...`));
            restartPhotos(what_if);
        }
        Logger.log(chalk.gray(`\t\tImporting chunk ${i}/${a.length}`));
        return importPhotosToAlbum(album_name, files, what_if);
    });
}

export function importPhotosToAlbum(album_name: string, UNSAFE_files_ESCAPE_THESE: string[], what_if: boolean): { photoId: string; albumId: string; }[] {
    if (UNSAFE_files_ESCAPE_THESE.length === 0) {
        Logger.log(`\tSkipping ${album_name} - no photos to add.`);
        return [];
    }

    // Just concatenate the files for ease of editing. The album_name is still
    // passed in as an arg to get it escaped nicely.
    const script = `
        on run argv
            tell application "Photos"
                set album_name to item 1 of argv
                if (exists album named album_name) then
                    set a to album named album_name
                else
                    set a to make new album named album_name
                end if

                set images to { ${UNSAFE_files_ESCAPE_THESE.map((f) => `"${f}" as POSIX file`).join(", ")} }
                import images into a without skip check duplicates
            end tell
        end run
    `;

    if (what_if) {
        Logger.log(script);
        return [];
    } else {
        const result = child_process.spawnSync("osascript", ["-", album_name], { input: script });
        const output = result.stdout.toString("utf-8");
        if (result.stderr.length != 0) {
            throw new Error(result.stderr.toString("utf-8"));
        }
        Logger.verbose(output);
        if (output.trim().length === 0) {
            return [];
        }
        const imported = output.trim().split(",");
        // Logger.log(imported);
        const ids = imported.map((item) => {
            const result = item.trim().match(/^media item id (.*?) of album id (.*)/)!;
            return {
                photoId: result[1],
                albumId: result[2],
            };
        });
        // Logger.log(ids);
        return ids;
    }
}

export function getInfoForPhotoIds(UNSAFE_ids_ESCAPE_THESE: string[]): { id: string; filename: string; size: number; timestamp: number; }[] {
    if (UNSAFE_ids_ESCAPE_THESE.length === 0) {
        return [];
    }

    // Just concatenate the files for ease of editing.
    const DATA_POINT_DIVIDER = "✂";
    const ITEM_DIVIDER = "☇";
    const script = `
        on unixDate(datetime)
            set command to "date -j -f '%A, %B %e, %Y at %I:%M:%S %p' '" & datetime & "'"
            set command to command & " +%s"
            
            set theUnixDate to do shell script command
            return theUnixDate
        end unixDate

        on run argv
            tell application "Photos"
                set output to ""
                set ids to { ${UNSAFE_ids_ESCAPE_THESE.map((i) => `"${i}"`).join(", ")} }
                repeat with i in ids
                    set img to media item id i
                    set output to output & (filename of img) & "${DATA_POINT_DIVIDER}" & (size of img) & "${DATA_POINT_DIVIDER}" & (my unixDate(get date of img)) & "${ITEM_DIVIDER}"
                end repeat

                return output
            end tell
        end run
    `;

        const result = child_process.spawnSync("osascript", ["-"], { input: script });
        const output = result.stdout.toString("utf-8");
        if (result.stderr.length != 0) {
            throw new Error(result.stderr.toString("utf-8"));
        }
        Logger.verbose(output);
        if (output.trim().length === 0) {
            return [];
        }
        const items = output.trim().split(ITEM_DIVIDER);
        items.pop(); // Last one is blank
        // Logger.log(items);
        const images = items.map((s, i) => {
            const parts = s.split(DATA_POINT_DIVIDER);
            const filename = parts[0];
            const size = parseInt(parts[1]);
            const timestamp = parseInt(parts[2]);
            return {
                id: UNSAFE_ids_ESCAPE_THESE[i],
                filename: filename,
                size: size,
                timestamp: timestamp
            }
        });
        return images;
}