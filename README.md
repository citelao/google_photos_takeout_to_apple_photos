# Google Photos to Apple Photos

(yet another one)

## Features

* Pairs live photos
* Tries to be robust across multiple runs

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

# You can inspect media items (launch them in Photos):
npm run inspect -- 330479A1-76F1-4FC6-8E17-4F04182628D6/L0/001
```
