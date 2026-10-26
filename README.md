# BT - Bookmark Tab

A JSON-driven bookmark manager that replaces your new tab page. No server needed. Only the background photos use the internet.

## Install (Chrome / Edge / Brave)

1. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this `bookmark-manager` folder.
4. Open a new tab. If Chrome asks "Change back to Google?", choose **Keep it**.

Don't move or delete this folder afterwards. Chrome loads the extension from here.

## JSON format

```json
{
  "personal": {
    "default": true,
    "github-repos": {
      "my-repo": "github.com/my-repo"
    },
    "daily": {
      "Gmail": "mail.google.com",
      "news": {
        "Hacker News": "news.ycombinator.com"
      }
    }
  }
}
```

- Top-level keys are **pages** (left sidebar). The page with `"default": true` opens first.
- Inside a page, objects are **categories** (cards).
- Inside a category, strings are **links** and objects are **subcategories** (which hold links).
- `default` is reserved, so don't use it as a category name.
- `https://` is added automatically when a link has no scheme.

## Using it

- **`{ }` button**: edit the raw JSON. It checks the JSON before saving. `Cmd/Ctrl+S` saves.
  Import and export a `.json` file from here to back up.
- **Pencil**: rename or edit a page, category, subcategory or link. Edit a page to set it as the default.
- **Plus**: add a page (sidebar), a category (page header), or a link or subcategory (card header).
- **Trash**: delete, with a confirm step.
- **Filter** (top right): search every page. Press `/` or `Cmd/Ctrl+K` to focus it, Enter to open the first match, Esc to clear.
- **Clock**: click it to switch between 12-hour and 24-hour time.
- **Theme button**: cycles system, light and dark.
- **Refresh button**: shows the next background photo right away. Use it when a photo makes text hard to read.
- **Image button**: background settings. Pick Photos or Plain, how often the photo changes (every new tab, 30 minutes, an hour, a day, or never), and how much to dim it.

## Background photos

Photos are free Unsplash images served by [Lorem Picsum](https://picsum.photos), so no API key is needed. The photographer is credited in the bottom-right corner.
The current photo and the next one are kept in the browser cache. Switching is instant, and the last photo still shows when you're offline (otherwise the page falls back to the plain gradient).
To keep text readable, cards get a stronger frosted-glass effect, the clock gets a soft shadow, and the photo is dimmed more automatically when it's too bright or too dark for the current theme.

## Storage

Bookmarks are saved in the extension's own storage, so they survive reloads and browser restarts.
They are also copied to your browser account's sync storage (up to about 90 KB) so they follow you to other signed-in devices.
Removing the extension deletes its storage, so **export a backup first**.

Favicons come from the browser's own icon cache, so they work offline. Sites you've never visited show a letter badge instead.
