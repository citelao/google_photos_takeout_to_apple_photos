# Google Photos to Apple Photos

(yet another one, and this one isn't very good)

## Features

* Pairs live photos
* Tries to be robust across multiple runs
* Testament to the hubris of man

## Usage 

```
# Requires exiftool:
brew install exiftool

npm install

# Parse the directory
npm run go -- path/to/takeout
# Import, based on the output from parsing:
npm run go -- output.json -d

# Or just do it all at once:
npm run go -- path/to/takeout -d

# You can run only for specific albums:
npm run go -- path/to/takeout -a "Photos from 2020"
npm run go -- output.json -a "Photos from 2020"

# Or skip albums that are causing problems:
npm run go -- output.json -s "Photos from 2014" "Study Abroad: North Trip"

# You can inspect media items (launch them in Photos):
npm run inspect -- 330479A1-76F1-4FC6-8E17-4F04182628D6/L0/001
```

Whenever Photos asks to import:

* Click "Apply to all duplicates"
* `Don't import`

## Results

After working on this for months, I finally ran it end-to-end.

The results were *decent* but extremely unreliable.

### Photos app doesn't like too many imports

The Photos app gets confused if you try to import to much stuff (by size?) at once, so at one point I "chunked" the imports. However, if you import a Live Photo *photo* in one chunk and a Live Photo *video* in another, the first item will go away---the media item ID the first import generates will just fail to find anything. I *believe* I mitigated this issue by dramatically improving the Live Photo detection, but I think I was running into sporadic errors after (though... there are sporadic errors everywhere).

In the end, I had to restart the tool several times *and* add "skip" (`-s`) flags to skip the most troublesome (read: large) albums that would stall out the import.

### Dupe detection is bad

Furthermore, dupe detection is just abysmal. I could not find a fast way to export photos from Photos to actually compare using imagemagick (which would be extremely slow anyway, at least to do NxN matching; maybe I could have generated a hash map or something...). I'm going by heuristics like file name, size, and timestamp, all of which *suck*: Google Photos loves to rename photos (though I correct for *some* of that, like name *truncation*), I found that older Live Photo videos got re-encoded, and timestamp is not reliable at all for my DSLR photos, perhaps because I'm not correcting for time zone properly.

The script is "intelligent" and augments its `output.json` with the results from previous runs, so we don't try to reimport *most* imported images, but we have to rely on heuristics to understand what image *actually* corresponds to the imported media item ID (we just get a list of imports, not a map of input to result), so we end up missing a few. I recommend "Don't import" for dupes that Photos detects, which skips a bunch of dupes *we* don't catch, but also means that *every time you rerun the script* you have to go through dialog after dialog saying "do not import" (space to check the "apply to all", click don't import; it's decent enough). If you wait a few minutes, the Applescript times out.

Despite all of that, though, some dupes *still* slip through. At one point, I had 8 of the same photo---I noticed that certain photos from certain albums always managed to sneak in. I think it was mostly photos with no created time metadata and my SnapChat saves.

*AND* Google Photos didn't understand Live Photos for a while, so the *source files* themselves (from Google Takeout) often had dupes of their own. Yikes. Though we *mostly* detect those, especially (only?) Live Photos.

### Still messy

The whole goal with this tool was to get rid of messiness---have a *program* recreate my albums and import any missing photos. I *could* do it myself, but that's error-prone.

However, the whole endeavor ended up unreliable:

* Not all *existing photos* were reliably detected and moved to the albums we created.
* Not all *missing photos* were reliably imported, since I had to skip large albums when they stalled out Apple Photos.
* Once I cleaned up dupes with PhotoSweeper X, many of the albums ended up empty (because I... removed the photos I'd added). Actually, many of the albums were empty *anyway*. I don't know.

### Missing timestamps

This is "par for the course" with imports, but many photos (especially Snapchat saves, grrrr) were completely missing timestamp metadata. So now I have a clump of images from 2014-today that all have the timestamp "whenever I happened to import them into Apple Photos." This has been a recurring problem for me with Google Photos, so I'm used to it. And the problem "goes away" as time goes on and I can forget I ever imported anything ever.

There will just be weird chunks of SnapChats if I ever look back at 2022 (and 2018 or whenever I switched to Google Photos when it did the same thing). I can recognize them because they look like SnapChats and screenshots; it's not a huge issue.

### *Weird* timestamps

Furthermore, there are *tons* of photos in Google Photos that have a mismatch between the timestamp in their manifest JSON and their EXIF data. Maybe because I manually corrected the timestamp in Google Photos? That's annoying. What's even more annoying is that I don't know which timestamp to use.

There are a bunch of photos that also have a few ticks of mismatch in their timestamp---between EXIF data in Apple Photos in Google Photos. That's even more inexplicable to me: shouldn't they be the same photo?

### Where are my RAWs?

I don't know if Google Photos ever had my RAWs, but they ain't in the Google Takeout. I probably have them on an external drive somewhere.

### Albums should have been sorted by date

I should have sorted my albums by date (or name) before creating them. Right now, they just kinda get created in whatever order they want. Hard to browse and hard to read. Oh well.

### Conclusion

My goals for this tool were:

* P0: Ensure my Apple Photos library had every single Google Photos photo.
* P1: Recreate my Google Photos albums in Apple Photos, 1-1.
* P1: Have fun writing something.

It was fun to write, and I learned a lot about Applescript, Apple Photos, and Google Photos. I also loved seeing all my old photos.

But the import was certainly unreliable, and recreating the albums 1-1 completely failed. I got maybe 80% of the albums created correctly, which is a horrible guarantee.

I ended up running PhotoSweeper X after all of this to remove duplicates and that was amazing and painless. Worth $10.

### Recommendations/alternatives

In the end, I recommend a different approach to imports:

1. Backup *everything*. Keep all the Google Takeout ZIPs and your original Apple Photos library. Set Apple Photos "Download Originals to this Mac" (which I'm leaving on permanently---it's so nice to have everything local again and I never want to give that up). Keep them on external drives and The Cloud somewhere.

2. Recreate albums. Honestly, maybe do it by hand. One option is simply run PhotoSweeper X *by album* in Takeout---mark all the dupes and then instead of deleting them in Apple Photos, drag them into a new album. You might also be able to script it somehow, but I'm not sure I'm ready for that commitment.

3. Run PhotoSweeper X on your combined Takeout folders + Apple Photos library (once everything is downloaded). Prioritize Apple Photos photos and have PhotoSweeper move all the dupes in the Takeout folder into the trash.

4. Import any remaining photos in the Takeout folders into Apple Photos---by dragging them in.

I worry about getting stuff out of Apple Photos---though at least I'll have the actual files and a SQLite database to use.

Long term:

* Don't do any weird customization in Albums (like cool text or whatever). Just keep photos in there, since that works with any photo software. Instead, create photo books when you want that customization, have them printed, and never worry about them Being Deleted.

* Keep everything local always. That's why I paid for big storage on my computer. If you have too many photos for that, buy Lightroom or Capture One.

I've had people recommend keeping photos in the filesystem only, but albums, tagging, viewing, sharing, and remote access are *so much better* in an app that it's a non-starter for me. I wish there were something better.

#### Recommendations using simpler_matcher.ts

Prerequisites: PhotoSweeper X, a download of your Google Takeout photos, a Photos library.

1. Run PhotoSweeper X on your Photos library side by side with the Google Takeout directory.

2. `File > Export to XML > List of Photos...`

3. Run `npm run simple -- path/to/the/export.plist path/to/takeout/dir` with `-c` to create the initial albums

4. Run `npm run simple -- path/to/the/export.plist path/to/takeout/dir` with `-m` to brute-force try to import all remaining missing images. *Always* choose don't import duplicates and apply to all (space, click, space, click, space, click).

5. Validate you've imported most of the photos (`npm run random -- ~/Downloads/takeout 20`, then check for those photos in Apple Photos). If you check 20 files, you have a 95% CI of 83%-100% import. 30: (88%-100%). https://epitools.ausvet.com.au/ciproportion

5. Delete all the Google Takeout stuff, since you've imported it (you have a backup, right?).

5. Download all your [shared albums](https://photos.google.com/sharing), since files you haven't saved to your library are not included in your Takeout.

    1. Open each album, and download the album if not all the photos are in your library. You can see this easily by looking to the top right of the album---if you are missing photos, there will be an "Add to library" cloud icon:

        ![Add to library button visible](/doc/google_photos_with_missing_photos.png)
    
        Otherwise, there will be no cloud icon:

        ![Add to library button visible](/doc/google_photos_without_missing_photos.png)

        You only need to download the albums that are missing photos, since those are the albums that will be missing photos if you use Google Takeout.


5. Open the shared albums and, uh, drag 'em into Photos, into the albums you want. Don't import duplicates.

### TODO

* [X] Remove all existing dupes in Photos library, to simplify output
* [X] Actually match dupes/not-dupes files
* [X] Generate a list of non-imported files
* [X] Import non-imported files
* [ ] Import shared albums