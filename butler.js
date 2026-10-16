const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const util = require('util');

// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
    TARGET_LIB_DIR: process.env.AUDIOBOOK_LIB_DIR || "./library",
    LOG_FILE_PATH: process.env.LOG_FILE_PATH || "./butler.log",
    GOOGLE_BOOKS_API_KEY: process.env.GOOGLE_BOOKS_API_KEY || "",

    // OLLAMA / QWEN SETTINGS (local inference via Ollama)
    OLLAMA_URL: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
    OLLAMA_MODEL: process.env.OLLAMA_MODEL || "qwen2.5:14b",

    QB_URL: process.env.QB_URL || "http://127.0.0.1:8080",
    QB_USER: process.env.QB_USER || "",
    QB_PASS: process.env.QB_PASS || "",
    EXIFTOOL_PATH: process.env.EXIFTOOL_PATH || "exiftool",
    AUDIO_EXTENSIONS: ['.m4b', '.m4a', '.mp3'],
    FORCE_MODE: false,
    DRY_RUN: false
};

// ============================================================================
// GLOBAL LOGGING OVERRIDE
// ============================================================================
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

function appendLog(level, ...args) {
    const msg = util.format(...args);
    const pad = (n) => n.toString().padStart(2, '0');
    const now = new Date();
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const logLine = `[${ts}] ${level} ${msg}\n`;
    try {
        fs.appendFileSync(CONFIG.LOG_FILE_PATH, logLine);
    } catch (e) {
        origError(`\n[CRITICAL LOG ERROR] Cannot write to "${CONFIG.LOG_FILE_PATH}": ${e.message}\n`);
    }
    return msg;
}

console.log = function(...args) { origLog(appendLog('[INFO]', ...args)); };
console.warn = function(...args) { origWarn(appendLog('[WARN]', ...args)); };
console.error = function(...args) { origError(appendLog('[ERROR]', ...args)); };

// ============================================================================
// HELPER FUNCTIONS & ASIN EXTRACTOR
// ============================================================================
const safeCmdStr = (str) => {
    if (!str) return "";
    let cleanStr = str.toString().replace(/\r?\n|\r/g, ' ');
    return cleanStr.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
};

function extractAsin(text) {
    if (!text) return null;
    const match = text.match(/\b(B0[A-Z0-9]{8})\b/i);
    return match ? match[1] : null;
}

function cleanJsonResponse(text) {
    if (!text) return "{}";
    let cleaned = text.trim();
    if (cleaned.startsWith("```json")) {
        cleaned = cleaned.replace(/^```json/, "").replace(/```$/, "").trim();
    } else if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```/, "").replace(/```$/, "").trim();
    }
    return cleaned;
}

async function searchAudibleForAsin(title, author) {
    if (!title) return null;
    const query = encodeURIComponent(`${title} ${author || ''}`.trim());
    const url = `https://www.audible.com/search?keywords=${query}`;

    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
                                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                                'Accept-Language': 'en-US,en;q=0.5'
            },
            signal: AbortSignal.timeout(15000)
        });

        if (!res.ok) return null;
        const html = await res.text();

        const match = html.match(/data-asin="(B0[A-Z0-9]{8})"/i) || html.match(/\/pd\/.*?\/(B0[A-Z0-9]{8})/i);
        if (match && match[1]) {
            return match[1].toUpperCase();
        }
    } catch (e) {
        console.warn(`    ⚠️ Audible scraping failed: ${e.message}`);
    }
    return null;
}

async function getQbittorrentContext(dirPath, files) {
    try {
        const loginRes = await fetch(`${CONFIG.QB_URL}/api/v2/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `username=${encodeURIComponent(CONFIG.QB_USER)}&password=${encodeURIComponent(CONFIG.QB_PASS)}`
        });

        if (!loginRes.ok) return null;
        const setCookie = loginRes.headers.get('set-cookie');
        if (!setCookie) return null;

        const torrentsRes = await fetch(`${CONFIG.QB_URL}/api/v2/torrents/info`, {
            headers: { 'Cookie': setCookie }
        });

        if (!torrentsRes.ok) return null;
        const torrents = await torrentsRes.json();

        const dirLower = path.resolve(dirPath).toLowerCase();
        const fileLower = files.length === 1 ? path.resolve(files[0]).toLowerCase() : null;

        const matched = torrents.find(t => {
            const tSavePath = (t.save_path || '').toLowerCase();
            const tName = (t.name || '').toLowerCase();
            const tContentPath = (t.content_path || '').toLowerCase();
            const tFull = path.join(tSavePath, tName);

            return (tContentPath === dirLower || tContentPath === fileLower || tFull === dirLower || tFull === fileLower);
        });

        if (matched) {
            try {
                await fetch(`${CONFIG.QB_URL}/api/v2/torrents/pause`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Cookie': setCookie
                    },
                    body: `hashes=${matched.hash}`
                });
                console.log(`    🛑 Stopped torrent in qBittorrent to prevent I/O locking.`);
            } catch (pauseErr) {
                console.warn(`    ⚠️ Failed to stop torrent: ${pauseErr.message}`);
            }

            return { originalName: matched.name, category: matched.category, tags: matched.tags };
        }
    } catch (err) {
        console.warn(`    ⚠️ qBittorrent API connection warning: ${err.message}`);
    }
    return null;
}

async function readNfoContent(dirPath) {
    try {
        const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });

        let metaFile = entries.find(e => e.isFile() && e.name.toLowerCase().endsWith('.nfo'));
        if (!metaFile) metaFile = entries.find(e => e.isFile() && e.name.toLowerCase().endsWith('.txt') && !e.name.toLowerCase().includes('concat'));

        if (metaFile) {
            const content = await fsPromises.readFile(path.join(dirPath, metaFile.name), 'utf8');
            return content.substring(0, 2000).trim();
        }
    } catch (err) {}
    return null;
}

function readAudioTags(filePath) {
    try {
        const cmd = `${CONFIG.EXIFTOOL_PATH} -j -Artist -AlbumArtist -Author -Title -Album -Composer -Series -SeriesPart -Genre "${safeCmdStr(filePath)}"`;
        const output = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        const data = JSON.parse(output);

        if (data && data.length > 0) {
            const tags = data[0];
            let extracted = {};
            if (tags.Title) extracted.Title = tags.Title;
            if (tags.Album) extracted.Album = tags.Album;
            if (tags.Artist) extracted.Artist = tags.Artist;
            if (tags.AlbumArtist) extracted.AlbumArtist = tags.AlbumArtist;
            if (tags.Author) extracted.Author = tags.Author;
            if (tags.Composer) extracted.Composer = tags.Composer;
            if (tags.Series) extracted.Series = tags.Series;
            if (tags.SeriesPart) extracted.SeriesPart = tags.SeriesPart;
            if (tags.Genre) extracted.Genre = tags.Genre;
            if (Object.keys(extracted).length > 0) return extracted;
        }
    } catch (e) {}
    return null;
}

async function scanAndGroupDirectories(targetRoot, dirPath = targetRoot, groups = {}) {
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
    const audioFiles = [];

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            await scanAndGroupDirectories(targetRoot, fullPath, groups);
        } else if (entry.isFile()) {
            if (CONFIG.AUDIO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
                audioFiles.push(fullPath);
            }
        }
    }

    if (audioFiles.length > 0) {
        const safeBase = path.basename(dirPath).toLowerCase();
        const protectedNames = ['staging', 'downloads', 'media', 'books', 'valhalla'];
        const isProtected = protectedNames.includes(safeBase) || path.resolve(dirPath) === path.resolve(targetRoot);

        let processedSet = new Set();
        const flagPath = path.join(dirPath, '.abs-processed');
        if (!CONFIG.FORCE_MODE && fs.existsSync(flagPath) && !isProtected) {
            try {
                const manifest = JSON.parse(await fsPromises.readFile(flagPath, 'utf8'));
                if (manifest.processedFiles && Array.isArray(manifest.processedFiles)) {
                    manifest.processedFiles.forEach(f => processedSet.add(path.resolve(dirPath, f)));
                }
            } catch (e) {}
        }

        const unprocessedAudioFiles = CONFIG.FORCE_MODE ? audioFiles : audioFiles.filter(f => !processedSet.has(path.resolve(f)));

        if (unprocessedAudioFiles.length === 0) {
            console.log(`    ⏭️ Skipping fully processed directory: "${dirPath}"`);
            return groups;
        }

        let allAreMp3 = unprocessedAudioFiles.every(f => path.extname(f).toLowerCase() === '.mp3');

        if (isProtected || !allAreMp3) {
            for (const file of unprocessedAudioFiles) {
                let baseName = path.basename(file, path.extname(file));
                let groupKey = baseName;

                // 1. Group by ASIN if present in the filename (strip track numbers after ASIN)
                // Handles: "The Truth: Discworld, Book 25 [B09MDJ4C8L] - 01 - Opening Credits"
                const asinMatch = baseName.match(/^(.*?\[B0[A-Z0-9]{8}\])/i);
                if (asinMatch) {
                    groupKey = asinMatch[1].trim();
                } else {
                    // 2. Strip " - Chapter 1", " - Part 1", etc.
                    groupKey = baseName.replace(/\s*-\s*(?:chapter|ch|part|pt|episode|ep)\s*\d+.*$/i, '').trim();
                    // 3. Strip " - 01 (enhanced)" or " - 01" at the end of the filename
                    groupKey = groupKey.replace(/\s*-\s*\d{2,4}(?:\s*\(.*?\))?$/i, '').trim();
                    // 4. Strip internal (Part 1) style tags
                    groupKey = groupKey.replace(/\[?\(?(?:part\vert{}pt\vert{}cd\vert{}disc\vert{}disk)[\s\-\_]*[\d\.\/]+\]?\)?/ig, '').trim();
                }

                if (!groupKey) groupKey = baseName;

                let uniqueKey = path.join(dirPath, groupKey);
                if (!groups[uniqueKey]) groups[uniqueKey] = [];
                groups[uniqueKey].push(file);
            }
        } else {
            groups[dirPath] = unprocessedAudioFiles;
        }
    }
    return groups;
}

// ----------------------------------------------------------------------------
// PASS 1: The LLM scavenger (Ollama)
// ----------------------------------------------------------------------------
async function queryOllama(prompt, systemPrompt = "You are a strict metadata parser. You always respond in valid JSON format.") {
    const res = await fetch(`${CONFIG.OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(120000),
        body: JSON.stringify({
            model: CONFIG.OLLAMA_MODEL,
            system: systemPrompt,
            prompt: prompt,
            stream: false,
            options: { temperature: 0.1 }
        })
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Ollama API returned status ${res.status}: ${errText}`);
    }

    const data = await res.json();
    return JSON.parse(cleanJsonResponse(data.response));
}

// ----------------------------------------------------------------------------
// PRE-PASS: Detect distinct books in a multi-file group
// ----------------------------------------------------------------------------
async function detectDistinctBooks(fileNames) {
    // Quick regex check first: "Series - ## - Title" pattern
    // If all files match and have different numbers/titles, it's multiple books
    const seriesPattern = /^(.+?)\s*-\s*(\d{1,3})\s*-\s*(.+?)\.(m4b|m4a|mp3)$/i;
    const parsed = fileNames.map(f => {
        const m = f.match(seriesPattern);
        return m ? { series: m[1].trim(), number: m[2], title: m[3].trim(), file: f } : null;
    });

    if (parsed.every(p => p !== null)) {
        const seriesNames = new Set(parsed.map(p => p.series.toLowerCase()));
        const titles = new Set(parsed.map(p => p.title.toLowerCase()));
        // Same series, different titles = multiple books in a series
        if (seriesNames.size === 1 && titles.size > 1) {
            const series = parsed[0].series;
            return parsed.map(p => ({
                label: `${series} - ${p.number} - ${p.title}`,
                files: [p.file]
            }));
        }
    }

    // Fall back to AI for ambiguous cases (only if more than 3 files)
    if (fileNames.length <= 3) return null;

    const prompt = `
    Look at these audiobook filenames and determine if they represent ONE book (multiple parts/chapters)
    or MULTIPLE distinct books.

    Filenames: ${JSON.stringify(fileNames)}

    - If it's ONE book split into parts, return: {"distinct_books": 1}
    - If it's MULTIPLE books, return: {"distinct_books": N, "books": [{"label": "Book Label", "files": ["file1", "file2"]}]}

    Return ONLY valid JSON.
    `;

    try {
        const result = await queryOllama(prompt);
        if (result.distinct_books > 1 && result.books) {
            return result.books;
        }
    } catch (e) {
        console.warn(`    ⚠️ Multi-book detection failed: ${e.message}`);
    }
    return null;
}

async function queryQwenMetadata(contextName, fileNames, qbContext, nfoText, audioTags) {
    const nfoSection = nfoText ? `\n    - NFO/Text File Content: ${JSON.stringify(nfoText)}` : "";
    const tagsSection = audioTags ? `\n    - Embedded ID3/Audio Tags: ${JSON.stringify(audioTags)}` : "";

    const prompt = `
    Analyze these metadata sources for an audiobook:
    - File/Folder Context: "${contextName}"
    - Sample Filenames: ${JSON.stringify(fileNames.slice(0, 5))}
    - qBittorrent Release Name: "${qbContext?.originalName || 'None'}"${nfoSection}${tagsSection}

    Extract metadata cleanly.
    1. author: Author Name. (If not explicitly written, return empty string).
    2. title: Best guess at the Book Title.
    3. series: Series Name.
    4. book_number: Series index ONLY (e.g., '1', '2', '1.5').
    5. edition: Special version tags (e.g., "Graphic Audio", "Full Cast", "Dramatization").
    6. narrator: Narrator Name.
    7. genre: The book's genre or category (e.g., Sci-Fi, Fantasy, Business, Romance).

    Return ONLY a JSON object matching this schema:
    { "author": "", "title": "", "series": "", "book_number": "", "edition": "", "narrator": "", "genre": "" }
    `;

    try {
        return await queryOllama(prompt);
    } catch (e) {
        throw new Error(`Qwen/Ollama lookup failed: ${e.message}`);
    }
}

// ----------------------------------------------------------------------------
// PASS 2: The Qwen Sanitizer
// ----------------------------------------------------------------------------
async function sanitizeApiString(rawString) {
    if (!rawString) return null;
    const prompt = `
    You are a strict metadata parser. Extract the true Title, Series Name, and Book Number from this raw audiobook string:
    "${rawString}"

    CRITICAL RULES:
    1. iTunes often formats strings as "Title: Series, Book 1", "Series: Title, Book 1", or "Title (Series, Book 1)".
    2. The "title" field MUST NOT contain the series name or the book number. Strip them out completely.
    3. The "series" field MUST ONLY contain the exact name of the series. If there is no series, return "".
    4. The "book_number" field MUST ONLY contain the digit (e.g. "1", "3.5"). Strip the word "Book" or "Vol".
    5. If the string is just a standalone book title, return empty strings for series and book_number.
    6. NEVER use the book title as the series name. If unsure, return "" for series.

    Return ONLY a JSON object matching this schema:
    { "title": "Clean Title", "series": "Clean Series Name", "book_number": "Number" }
    `;

    try {
        return await queryOllama(prompt, "You are a strict metadata parsing engine. You always respond in valid JSON format.");
    } catch (e) {
        console.warn(`    ⚠️ Qwen sanitizer failed: ${e.message}`);
    }
    return null;
}

// ============================================================================
// METADATA PROVIDERS: Audnexus -> Google Books -> iTunes
// ============================================================================
async function queryAudnexus(asin) {
    if (!asin) return null;
    try {
        const res = await fetch(`https://api.audnex.us/books/${asin}`);
        if (!res.ok) return null;
        const item = await res.json();

        let seriesName = null;
        let seriesNum = null;
        if (item.series && item.series.length > 0) {
            seriesName = item.series[0].name || null;
            seriesNum = item.series[0].position ? item.series[0].position.toString() : null;
        }

        return {
            title: item.title || null,
            author: (item.authors && item.authors.length > 0) ? item.authors[0].name : null,
            series: seriesName,
            book_number: seriesNum,
            narrator: (item.narrators && item.narrators.length > 0) ? item.narrators[0].name : null,
            genre: (item.genres && item.genres.length > 0) ? item.genres[0].name : null,
            year: item.releaseDate ? item.releaseDate.substring(0, 4) : null,
            description: item.description ? item.description.replace(/<[^>]*>?/gm, '').trim() : null,
            copyright: item.publisherName ? `© ${item.publisherName}` : null,
            coverUrl: item.image || null
        };
    } catch (err) {
        console.warn(`    ⚠️️ Audnexus API lookup warning: ${err.message}`);
    }
    return null;
}

async function queryiTunesAudiobook(title, author) {
    if (!title) return null;
    let searchTerm = author ? `${author} ${title}`.trim() : title.trim();
    try {
        const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&media=audiobook&entity=audiobook&limit=1`);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.resultCount > 0 && data.results[0]) {
            const item = data.results[0];
            return {
                title: item.trackName || item.collectionName || null,
                author: item.artistName || null,
                series: null,
                narrator: item.collectionArtistName || null,
                genre: item.primaryGenreName || null,
                year: item.releaseDate ? item.releaseDate.substring(0, 4) : null,
                description: item.description ? item.description.replace(/<[^>]*>?/gm, '').trim() : null,
                copyright: item.copyright || null,
                coverUrl: item.artworkUrl100 ? item.artworkUrl100.replace('100x100bb.jpg', '600x600bb.jpg') : null
            };
        }
    } catch (err) {}
    return null;
}

async function queryGoogleBooks(title, author) {
    if (!CONFIG.GOOGLE_BOOKS_API_KEY || !title) return null;
    let queryStr = `intitle:${encodeURIComponent(title)}`;
    if (author) queryStr += `+inauthor:${encodeURIComponent(author)}`;

    try {
        let res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${queryStr}&key=${CONFIG.GOOGLE_BOOKS_API_KEY}`);
        if (!res.ok) return null;
        let data = await res.json();

        if ((!data.totalItems || data.totalItems === 0) && author) {
            res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(title)}&key=${CONFIG.GOOGLE_BOOKS_API_KEY}`);
            if (res.ok) data = await res.json();
        }

        if (data.totalItems > 0 && data.items[0].volumeInfo) {
            const info = data.items[0].volumeInfo;
            let coverUrl = info.imageLinks?.thumbnail ? info.imageLinks.thumbnail.replace("&edge=curl", "").replace("zoom=1", "zoom=3") : null;
            return {
                title: info.title || null,
                author: info.authors ? info.authors[0] : null,
                series: info.seriesInfo ? info.seriesInfo.series : null,
                genre: (info.categories && info.categories.length > 0) ? info.categories[0] : null,
                year: info.publishedDate ? info.publishedDate.substring(0, 4) : null,
                description: info.description ? info.description.replace(/<[^>]*>?/gm, '').trim() : null,
                coverUrl: coverUrl
            };
        }
    } catch (err) {}
    return null;
}

function tagAudioFile(filePath, metadata) {
    // Tags a LOCAL file in place. Callers stage via /tmp to avoid NFS in-place modify issues.
    const ext = path.extname(filePath).toLowerCase();

    // MP3 files: use mid3v2 (ExifTool can't write MP3)
    if (ext === '.mp3') {
        let cmd = `mid3v2 ` +
        `--artist="${safeCmdStr(metadata.author)}" ` +
        `--album="${safeCmdStr(metadata.title)}" ` +
        `--song="${safeCmdStr(metadata.title)}" ` +
        `--genre="${safeCmdStr(metadata.genre)}" `;

        if (metadata.year) cmd += `--year="${safeCmdStr(metadata.year)}" `;
        // mid3v2 has no --composer; store narrator + series in comment
        // format: --comment="DESCRIPTION":"COMMENT":"LANGUAGE"
        let commentParts = [];
        if (metadata.narrator) commentParts.push(`Narrator: ${metadata.narrator}`);
        if (metadata.series) {
            let s = metadata.series;
            if (metadata.book_number) s += ` #${metadata.book_number}`;
            commentParts.push(`Series: ${s}`);
        }
        if (commentParts.length) {
            cmd += `--comment="":"${safeCmdStr(commentParts.join(' | '))}":"eng" `;
        }

        cmd += `"${filePath}"`;

        try { execSync(cmd, { stdio: 'pipe' }); }
        catch (e) {
            console.warn(`    ⚠️ MP3 tagging failed for: "${path.basename(filePath)}"`);
            console.warn(`    ⚠️ MP3 tag error: ${e.message?.substring(0, 200)}`);
        }
        return;
    }

    // M4B/M4A files: use ExifTool
    let exifCmd = `${CONFIG.EXIFTOOL_PATH} -overwrite_original_in_place ` +
    `-Artist="${safeCmdStr(metadata.author)}" ` +
    `-AlbumArtist="${safeCmdStr(metadata.author)}" ` +
    `-Album="${safeCmdStr(metadata.title)}" ` +
    `-Title="${safeCmdStr(metadata.title)}" ` +
    `-Composer="${safeCmdStr(metadata.narrator)}" ` +
    `-Genre="${safeCmdStr(metadata.genre)}" `;

    if (metadata.year) exifCmd += `-Year="${safeCmdStr(metadata.year)}" `;
    if (metadata.copyright) exifCmd += `-Copyright="${safeCmdStr(metadata.copyright)}" `;
    if (metadata.description) {
        exifCmd += `-Description="${safeCmdStr(metadata.description)}" `;
        exifCmd += `-Comment="${safeCmdStr(metadata.description)}" `;
    }
    if (metadata.series) {
        exifCmd += `-Series="${safeCmdStr(metadata.series)}" `;
        if (metadata.book_number) exifCmd += `-SeriesPart="${safeCmdStr(metadata.book_number)}" `;
    }

    exifCmd += `"${filePath}"`;

    try { execSync(exifCmd, { stdio: 'pipe' }); }
    catch (e) {
        console.warn(`    ⚠️ ExifTool tagging failed for: "${path.basename(filePath)}"`);
        console.warn(`    ⚠️ ExifTool error: ${e.message?.substring(0, 200)}`);
    }
}

async function downloadCover(url, targetDir) {
    try {
        const coverRes = await fetch(url);
        if (!coverRes.ok) return;
        const arrayBuffer = await coverRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const destPath = path.join(targetDir, 'cover.jpg');
        await fsPromises.writeFile(destPath, buffer);
        console.log(`    🖼️ Cover art downloaded and saved to: "${destPath}"`);
    } catch (err) {}
}

// ============================================================================
// CORE PROCESSING ENGINE
// ============================================================================
async function processBookGroup(dirPath, files, groupContextName) {
    console.log(`\n=================================================`);
    console.log(`🚀 [START] Processing Target: "${groupContextName}"`);
    console.log(`📚 Found ${files.length} audio file(s).`);

    let qbContext = null;
    try { qbContext = await getQbittorrentContext(dirPath, files); } catch (e) {}

    let nfoText = await readNfoContent(dirPath);
    let audioTags = files.length > 0 ? readAudioTags(files[0]) : null;
    const fileNames = files.map(f => path.basename(f));

    // --- 0. MULTI-BOOK DETECTION: split if this group contains distinct books ---
    // (e.g., "Destroyermen - 01 - Into the Storm.mp3" through "... - 10 - Straits of Hell.mp3")
    if (files.length > 1) {
        const distinctBooks = await detectDistinctBooks(fileNames);
        if (distinctBooks && distinctBooks.length > 1) {
            console.log(`    📚 Detected ${distinctBooks.length} distinct books in this group. Splitting...`);
            for (const book of distinctBooks) {
                const bookFiles = files.filter(f => book.files.includes(path.basename(f)));
                if (bookFiles.length > 0) {
                    await processBookGroup(dirPath, bookFiles, book.label || path.basename(bookFiles[0], path.extname(bookFiles[0])));
                }
            }
            return; // done - each book was processed recursively
        }
    }

    // --- 1. CHECK FILENAME FOR ASIN ---
    const searchStringBlock = `${groupContextName} ${dirPath} ${nfoText || ""} ${fileNames.join(' ')}`;
    let foundAsin = extractAsin(searchStringBlock);
    let apiMeta = null;

    if (foundAsin) {
        console.log(`    🔍 Found Audible ASIN [${foundAsin}] in path. Querying Audnexus API...`);
        apiMeta = await queryAudnexus(foundAsin);
    }

    // --- 2. NO ASIN? SCAVENGE WITH DEEPSEEK AND SCRAPE AUDIBLE ---
    let aiMeta = { title: groupContextName, author: "", series: "", book_number: "", edition: "", narrator: "", genre: "" };
    let fastPathSeries = null;

    if (!apiMeta) {
        console.log(`    🧠 [PASS 1] Scavenging with Qwen...`);
        try {
            aiMeta = await queryQwenMetadata(groupContextName, fileNames, qbContext, nfoText, audioTags);
        } catch (e) {
            console.warn(`    ⚠️ Qwen lookup failed: ${e.message}`);
        }

        // FAST PATH: if filename clearly matches "Series - ## - Title", trust the regex
        // and skip both Qwen and the Audible scrape for title/series/number
        // (Qwen sometimes returns the series name as the title; the regex doesn't lie)
        const seriesFilePattern = /^(.+?)\s*-\s*(\d{1,3})\s*-\s*(.+?)\.(m4b|m4a|mp3)$/i;
        const fileMatch = fileNames.length === 1 ? fileNames[0].match(seriesFilePattern) : null;
        let fastPathMeta = null;
        if (fileMatch) {
            fastPathMeta = {
                series: fileMatch[1].trim(),
                book_number: fileMatch[2].trim(),
                title: fileMatch[3].trim()
            };
            console.log(`    ⚡ [FAST PATH] Filename gives: Series="${fastPathMeta.series}" #${fastPathMeta.book_number} Title="${fastPathMeta.title}"`);
        }

        // Track if fast path provided series (to prevent ancestry override)
        // (fastPathSeries declared at function scope above)
        if (fastPathMeta) {
            // Override Qwen's title/series/number with regex-extracted values
            aiMeta.title = fastPathMeta.title;
            aiMeta.series = fastPathMeta.series;
            aiMeta.book_number = fastPathMeta.book_number;
            fastPathSeries = fastPathMeta.series;
            console.log(`    ⚡ [FAST PATH] Skipping Audible scrape, using filename metadata.`);
            foundAsin = null;
        } else {
            // Sanitize the search query so Audible doesn't choke on "Mort (#4)"
            const cleanSearchTitle = aiMeta.title.replace(/[\[\(].*?[\]\)]/g, '').replace(/#\d+/g, '').replace(/^\d+[\s.-]+/g, '').trim();

            console.log(`    🕵️‍♂️ Searching Audible.com for an ASIN match for "${cleanSearchTitle}"...`);
            foundAsin = await searchAudibleForAsin(cleanSearchTitle, aiMeta.author);
        }

        if (foundAsin) {
            console.log(`    🎯 Scraped ASIN [${foundAsin}]. Querying Audnexus API...`);
            apiMeta = await queryAudnexus(foundAsin);

            // Validate: Audnexus title must match Qwen's title (fuzzy)
            // Prevents wrong-book overwrites (e.g., ASIN for book 10 used for book 9)
            if (apiMeta && apiMeta.title && aiMeta.title) {
                const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
                const apiTitleNorm = normalize(apiMeta.title);
                const aiTitleNorm = normalize(aiMeta.title);
                if (!apiTitleNorm.includes(aiTitleNorm) && !aiTitleNorm.includes(apiTitleNorm)) {
                    console.warn(`    ⚠️ Audnexus title mismatch: API says "${apiMeta.title}" but Qwen said "${aiMeta.title}". Rejecting API result.`);
                    apiMeta = null;
                    foundAsin = null;
                }
            }
        }
    }

    // --- 3. FINAL FALLBACK TO GOOGLE / ITUNES (with validation) ---
    if (!apiMeta) {
        console.log(`    ⚠️ Audible search missed. Falling back to Google Books & iTunes APIs...`);
        let [googleMeta, itunesMeta] = await Promise.all([
            CONFIG.GOOGLE_BOOKS_API_KEY ? queryGoogleBooks(aiMeta.title, aiMeta.author) : Promise.resolve(null),
                                                         queryiTunesAudiobook(aiMeta.title, aiMeta.author)
        ]);

        // Validate API results: reject if author conflicts with known context
        // (e.g., Google Books returning "Mary Dove Brady" for a Terry Pratchett book)
        const knownAuthor = (aiMeta.author || "").toLowerCase().trim();
        for (const candidate of [googleMeta, itunesMeta]) {
            if (!candidate) continue;
            const candidateAuthor = (candidate.author || "").toLowerCase().trim();
            if (knownAuthor && candidateAuthor && knownAuthor !== candidateAuthor) {
                console.warn(`    ⚠️ API author mismatch: API says "${candidate.author}" but context says "${aiMeta.author}". Rejecting API result.`);
                continue;
            }
            apiMeta = candidate;
            break;
        }
    }

    let finalTitle = apiMeta?.title || aiMeta.title || groupContextName.replace(/\.(m4a|m4b|mp3)$/i, '');
    let finalSeries = "";
    let finalBookNum = apiMeta?.book_number || aiMeta.book_number || "";

    if (apiMeta?.title && !foundAsin) {
        const needsSanitizing = /:|[\(\)]|,|book\s*\d|vol\s*\d|part\s*\d/i.test(apiMeta.title);
        if (needsSanitizing) {
            console.log(`    🧠 [PASS 2] Sanitizing API Title with Qwen...`);
            const cleanApi = await sanitizeApiString(apiMeta.title);
            if (cleanApi) {
                finalTitle = cleanApi.title || apiMeta.title;
                if (cleanApi.series) finalSeries = cleanApi.series;
                if (cleanApi.book_number) finalBookNum = cleanApi.book_number;
            }
        } else {
            console.log(`    ⚡ [PASS 2 BYPASS] API Title looks perfectly clean. Bypassing AI Sanitizer.`);
        }
    }

    // --- 4. EXTRACT BOOK NUMBER FROM FOLDER IF MISSING ---
    if (!finalBookNum) {
        const numMatch = groupContextName.match(/^(?:\[|\()?#?(\d+(?:\.\d+)?)(?:\]\vert{}\)|\s*-)/) || groupContextName.match(/#(\d+(?:\.\d+)?)/);
        if (numMatch) finalBookNum = numMatch[1];
    }

    // Determine Final Author early so the Ancestry Walker can skip their name in the folder tree
    let fallbackAuthorFromPath = "";
    const parentDirMatch = path.basename(path.dirname(dirPath)).match(/^([^-]+)\s*-\s*/);
    if (parentDirMatch) fallbackAuthorFromPath = parentDirMatch[1].trim();

    let finalAuthor = apiMeta?.author || aiMeta.author || fallbackAuthorFromPath;
    const isAuthorUnknown = (authorStr) => !authorStr || /^(unknown|unknown author|none|null|undefined)$/i.test(authorStr.toString().trim());

    if (isAuthorUnknown(finalAuthor) && finalTitle) {
        const secondaryApi = await queryiTunesAudiobook(finalTitle, null);
        if (secondaryApi?.author) finalAuthor = secondaryApi.author;
    }
    finalAuthor = isAuthorUnknown(finalAuthor) ? "Unknown Author" : finalAuthor.toString().trim();

    // --- 5. SMART PATH ANCESTRY SERIES FALLBACK (PRIORITY OVERRIDE) ---
    let ancestrySeries = "";
    let currDir = dirPath;
    const genericNames = ['staging', 'books', 'media', 'valhalla', 'downloads', finalAuthor.toLowerCase()];

    while (currDir && currDir !== path.parse(currDir).root) {
        const folderName = path.basename(currDir);
        const lowerName = folderName.toLowerCase();

        if (!genericNames.includes(lowerName) &&
            lowerName !== finalTitle.toLowerCase() &&
            !folderName.match(/^(?:\[|\()?#?\d+(?:\.\d+)?(?:\]\vert{}\)|\s*-)/)) {
            ancestrySeries = folderName;
        break;
            }
            currDir = path.dirname(currDir);
    }

    // SET FINAL SERIES: Fast Path > Audnexus API > Ancestry Folder > AI/Google Books
    if (fastPathSeries) {
        finalSeries = fastPathSeries;
    } else if (foundAsin && apiMeta?.series) {
        finalSeries = apiMeta.series;
    } else if (ancestrySeries) {
        finalSeries = ancestrySeries;
    } else if (!finalSeries) {
        finalSeries = apiMeta?.series || aiMeta.series || "";
    }

    // Clean up junk series tags
    if (finalSeries) {
        const sLow = finalSeries.toLowerCase().trim();
        const tLow = finalTitle.toLowerCase().trim();
        const junkWords = ["unabridged", "a novel", "novel", "audiobook", "none", "standalone", "stand alone", "part one", "part two", "part 1", "part 2"];
        // Reject if series == title (e.g., "Mort (#4)" as series for book "Mort")
        const seriesIsJustTitle = sLow.replace(/^#\d+\s+|\s*\(#\d+\)\s*$/g, '').trim() === tLow.replace(/\s*\(unabridged\)\s*$/i, '').trim();
        if (sLow === tLow || junkWords.includes(sLow) || seriesIsJustTitle) {
            console.log(`    🧹 Rejected junk series "${finalSeries}" (matches book title).`);
            finalSeries = "";
        }
    }

    let finalGenre = "Audiobook";
    for (const g of [apiMeta?.genre, aiMeta.genre, audioTags?.Genre]) {
        if (g && !['audiobooks', 'audiobook'].includes(g.toLowerCase())) {
            finalGenre = g; break;
        }
    }

    if (aiMeta.edition && !finalTitle.toLowerCase().includes(aiMeta.edition.toLowerCase())) {
        finalTitle = `${finalTitle} (${aiMeta.edition})`;
    }

    const finalNarrator = apiMeta?.narrator || aiMeta.narrator || "";
    const coverUrl = apiMeta?.coverUrl || null;
    const finalYear = apiMeta?.year || "";
    const finalDesc = apiMeta?.description || "";
    const finalCopy = apiMeta?.copyright || "";

    console.log(`    ℹ️️ [FINAL] Title: "${finalTitle}" | Author: "${finalAuthor}" | Series: "${finalSeries}" [${finalBookNum}] | Genre: "${finalGenre}"`);

    if (CONFIG.DRY_RUN) {
        let dryFolder = finalTitle, dryPrefix = "";
        if (finalSeries && finalBookNum) {
            const nm = finalBookNum.toString().match(/[\d.]+/);
            if (nm) {
                let ns = nm[0];
                ns = ns.includes('.') ? ns.split('.')[0].padStart(2, '0') + '.' + ns.split('.')[1] : ns.padStart(2, '0');
                dryFolder = `${ns} - ${finalTitle}`;
                dryPrefix = `${ns} - `;
            }
        }
        let dryDir = path.join(CONFIG.TARGET_LIB_DIR, finalAuthor);
        if (finalSeries) dryDir = path.join(dryDir, finalSeries);
        dryDir = path.join(dryDir, dryFolder);
        console.log(`    🔍 [DRY-RUN] Would shelve to: "${dryDir}"`);
        files.forEach((f, i) => {
            const ext = path.extname(f);
            const name = files.length === 1 ? `${dryPrefix}${finalTitle}${ext}` : `${dryPrefix}${finalTitle} - pt${(i + 1).toString().padStart(files.length > 99 ? 3 : 2, '0')}${ext}`;
            console.log(`    🔍 [DRY-RUN]   ${path.basename(f)} -> ${name}`);
        });
        console.log(`    🔍 [DRY-RUN] Tags: narrator="${finalNarrator}" year="${finalYear}" genre="${finalGenre}"`);
        console.log(`    ✅ [DRY-RUN] No files written.`);
        return;
    }

    let folderName = finalTitle;
    let fileNamePrefix = "";

    if (finalSeries && finalBookNum) {
        const numMatch = finalBookNum.toString().match(/[\d.]+/);
        if (numMatch) {
            let numStr = numMatch[0];
            if (!numStr.includes('.')) numStr = numStr.padStart(2, '0');
            else numStr = numStr.split('.')[0].padStart(2, '0') + '.' + numStr.split('.')[1];
            folderName = `${numStr} - ${finalTitle}`;
            fileNamePrefix = `${numStr} - `;
        }
    }

    let targetDir = path.join(CONFIG.TARGET_LIB_DIR, finalAuthor);
    if (finalSeries) targetDir = path.join(targetDir, finalSeries);
    targetDir = path.join(targetDir, folderName);
    await fsPromises.mkdir(targetDir, { recursive: true });

    files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    for (let i = 0; i < files.length; i++) {
        const srcFile = files[i];
        const ext = path.extname(srcFile);
        let destFileName = files.length === 1 ? `${fileNamePrefix}${finalTitle}${ext}` : `${fileNamePrefix}${finalTitle} - pt${(i + 1).toString().padStart(files.length > 99 ? 3 : 2, '0')}${ext}`;
        const destFilePath = path.join(targetDir, destFileName);

        console.log(`    🚀 Copying audio to target: "${destFileName}"...`);

        // Stage via local /tmp: copy source -> tmp, tag tmp, copy tmp -> NFS destination.
        // This avoids ever modifying files in-place on the NFS mount (UID mapping issues).
        const os = require('os');
        const stageTmp = path.join(os.tmpdir(), `stage_${Date.now()}_${path.basename(destFileName)}`);
        const tagMeta = {
            author: finalAuthor,
            title: files.length === 1 ? finalTitle : `${finalTitle} (Part ${i + 1})`,
            series: finalSeries,
            book_number: finalBookNum,
            narrator: finalNarrator,
            genre: finalGenre,
            year: finalYear,
            description: finalDesc,
            copyright: finalCopy
        };
        try {
            await fsPromises.copyFile(srcFile, stageTmp);
            console.log(`    🏷️ Writing metadata tags...`);
            tagAudioFile(stageTmp, tagMeta);  // tags the local tmp copy in place
            await fsPromises.copyFile(stageTmp, destFilePath);
        } catch (e) {
            console.warn(`    ⚠️ Staged copy/tag failed (${e.message?.substring(0, 150)}), falling back to direct copy...`);
            await fsPromises.copyFile(srcFile, destFilePath);
        } finally {
            try { await fsPromises.unlink(stageTmp); } catch (e2) {}
        }
    }

    // Local assets
    try {
        const allEntries = await fsPromises.readdir(dirPath, { withFileTypes: true });
        let hasLocalCover = false;
        for (const entry of allEntries) {
            if (!entry.isFile() || entry.name.startsWith('.')) continue;
            const fullPath = path.join(dirPath, entry.name);
            if (files.includes(fullPath)) continue;

            const ext = path.extname(entry.name).toLowerCase();
            if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
                if (!hasLocalCover) {
                    await fsPromises.copyFile(fullPath, path.join(targetDir, `cover${ext}`));
                    hasLocalCover = true;
                }
            } else if (!CONFIG.AUDIO_EXTENSIONS.includes(ext)) {
                await fsPromises.copyFile(fullPath, path.join(targetDir, entry.name));
            }
        }
    } catch (e) {}

    if (coverUrl && !fs.existsSync(path.join(targetDir, 'cover.jpg'))) {
        await downloadCover(coverUrl, targetDir);
    }

    // Manifest audit log
    try {
        const safeBase = path.basename(dirPath).toLowerCase();
        if (!['staging', 'downloads', 'media', 'books', 'valhalla'].includes(safeBase)) {
            const flagPath = path.join(dirPath, '.abs-processed');
            let manifest = { processedFiles: [], history: [] };
            if (fs.existsSync(flagPath)) manifest = JSON.parse(await fsPromises.readFile(flagPath, 'utf8'));
            const relativeFiles = files.map(f => path.basename(f));
            manifest.processedFiles = Array.from(new Set([...(manifest.processedFiles || []), ...relativeFiles]));
            manifest.history.push({ timestamp: new Date().toISOString(), title: finalTitle, series: finalSeries });
            await fsPromises.writeFile(flagPath, JSON.stringify(manifest, null, 2));
            console.log(`    🔒 Updated '.abs-processed' manifest audit log in directory.`);
        }
    } catch (e) {}

    console.log(`    ✅ [SUCCESS] Processed -> "${targetDir}"`);
}

// ============================================================================
// MAIN CLI
// ============================================================================
async function main() {
    console.log(`\n=================================================`);
    console.log(`⚙️  Audiobook Processor Initializing...`);

    const argsRaw = process.argv.slice(2);
    if (argsRaw.includes('--force')) CONFIG.FORCE_MODE = true;
    if (argsRaw.includes('--dry-run')) CONFIG.DRY_RUN = true;
    const args = argsRaw.filter(a => a !== '--force' && a !== '--dry-run');

    if (args.length === 0) {
        console.log(`Usage: node butler.js [--force] [--dry-run] --batch /path/to/folder`);
        process.exit(0);
    }

    let targetPath = path.resolve(args[0] === '--batch' || args[0] === '--dir' || args[0] === '--torrent' ? args[1] : args[0]);
    if (!fs.existsSync(targetPath)) process.exit(1);

    const stats = await fsPromises.stat(targetPath);
    if (stats.isDirectory()) {
        const groups = await scanAndGroupDirectories(targetPath);
        for (const key of Object.keys(groups)) {
            await processBookGroup(path.dirname(groups[key][0]), groups[key], path.basename(key));
        }
    } else if (stats.isFile()) {
        await processBookGroup(path.dirname(targetPath), [targetPath], path.basename(targetPath, path.extname(targetPath)));
    }
}

main();
