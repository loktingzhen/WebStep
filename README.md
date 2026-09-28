# WebStep

WebStep is a Chrome extension that turns web interactions into step-by-step visual tutorials.

Instead of manually taking screenshots, organizing steps, and formatting documents, users can simply perform a workflow once and let WebStep generate an editable tutorial.

## Features

- Record clicks, text input, and other key web interactions
- Automatically generate step-by-step tutorials with screenshots
- Highlight interaction areas on screenshots
- Edit descriptions and add notes
- Reorder, add, or delete steps
- Add, replace, or remove screenshots
- Blur sensitive information
- Export tutorials as PDF

## Workflow

`Record → Generate → Edit → Export`

## Installation

1. Clone or download this repository.

```bash
git clone https://github.com/loktingzhen/WebStep.git
```

2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `操作过程自动变教程` folder.

## Usage

1. Click the WebStep extension icon.
2. Click **Start Recording** and perform the web workflow.
3. Click **Stop Recording** when finished.
4. Open the generated tutorial.
5. Edit the steps, screenshots, annotations, or privacy areas as needed.
6. Export the final tutorial as a PDF.

## Tech Stack

- Chrome Extension Manifest V3
- JavaScript
- HTML / CSS
- Chrome Storage
- IndexedDB

## Status

WebStep is currently a functional prototype (`v0.1.0`) covering the complete workflow from web interaction recording to tutorial generation, editing, and PDF export.
