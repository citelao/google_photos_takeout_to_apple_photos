import child_process from "child_process";

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
    // console.log(lines);
    const albums = lines.map((l) => {
        const pts = l.split(", ");
        return {
            name: pts[0],
            id: pts[1]
        };
    });

    return albums;
}

export function findPhotoInPhotos(images: {image_filename: string, image_timestamp: number | string, image_size: number}[]): (string | null)[] {
    // Derived from https://github.com/akhudek/google-photos-to-apple-photos/blob/main/migrate-albums.py
    const DIVIDER = "✂";
    const TIMESTAMP_TOLERANCE = "1";
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
                    if image_filename is equal to myFilename and mySize is equal to (image_size as integer)
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
    const flatArgs = images.map((i) => [i.image_filename, i.image_timestamp.toString(), i.image_size.toString()]).flat();
    const result = child_process.spawnSync("osascript", ["-", ... flatArgs], { input: FIND_PHOTO_SCRIPT});
    const output = result.stdout.toString("utf-8");
    if (result.stderr.length != 0) {
        throw new Error(result.stderr.toString("utf-8"));
    }
    const ids = output.split(DIVIDER);
    ids.pop(); // The last one is always that extra scissor.
    return ids.map((i) => i.trim() || null);
}
