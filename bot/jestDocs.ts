import * as fs from 'fs';
import * as path from 'path';

export interface JestDoc {
    key: string;          // lookup key, e.g. "toBe", "jest.mock", "test.each"
    heading: string;      // e.g. "jest.mock(moduleName, factory, options)"
    page: string;         // docs page slug, e.g. "expect"
    url: string;
    description: string;
    examples: string[];
}

const BASE = 'https://jestjs.io'
export const DOCS_FILE = path.join(__dirname, 'data', 'jest-docs.json')

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&nbsp;': ' ' }
const decode = (s: string) => s.replace(/&(lt|gt|amp|quot|nbsp|#x27|#39);/g, m => ENTITIES[m])
const text = (html: string) => decode(html.replace(/<[^>]+>/g, '')).replace(/\u200b/g, '').replace(/\s+/g, ' ').trim()

// "expect(value).toBe" is documented as ".toBe(value)"; normalise headings to a short lookup key
export const docKey = (heading: string): string =>
    heading.replace(/^(expect(\([^)]*\))?|mockFn)\./, '').replace(/^\./, '').replace(/\(.*$/, '').replace(/\[.*$/, '').trim()

function parsePage(slug: string, html: string): JestDoc[] {
    const article = html.match(/<article[\s\S]*?<\/article>/)?.[0] ?? ''
    const parts = article.split(/(?=<h[234][ >])/)
    const docs: JestDoc[] = []

    for (const part of parts) {
        const h = part.match(/^<h([234])[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/)
        if (!h) continue
        const heading = text(h[3].replace(/<a [^>]*hash-link[\s\S]*?<\/a>/, ''))
        const body = part.slice(h[0].length)

        const examples = [...body.matchAll(/<pre[\s\S]*?<\/pre>/g)].map(m =>
            decode(m[0].replace(/<\/div>/g, '\n').replace(/<[^>]+>/g, '')).replace(/\u200b/g, '').trim())
        const description = [...body.replace(/<pre[\s\S]*?<\/pre>/g, '').matchAll(/<p>([\s\S]*?)<\/p>/g)]
            .map(m => text(m[1])).join('\n')

        const key = docKey(heading)
        if (!key) continue
        docs.push({ key, heading, page: slug, url: `${BASE}/docs/${slug}#${h[2]}`, description, examples })
    }
    return docs
}

// Fetches every English /docs/* page listed in the sitemap and stores API entries in bot/data/jest-docs.json
export async function scrapeJestDocs(outFile = DOCS_FILE): Promise<JestDoc[]> {
    const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text()
    const slugs = [...sitemap.matchAll(/<loc>https:\/\/jestjs\.io\/docs\/([^</]+)<\/loc>/g)].map(m => m[1])
    const docs: JestDoc[] = []

    for (const slug of slugs) {
        const res = await fetch(`${BASE}/docs/${slug}`)
        if (!res.ok) {
            console.warn(`Skipping ${slug}: HTTP ${res.status}`)
            continue
        }
        docs.push(...parsePage(slug, await res.text()))
    }

    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, JSON.stringify(docs, null, 2))
    return docs
}

export function loadJestDocs(file = DOCS_FILE): JestDoc[] {
    if (!fs.existsSync(file)) {
        throw new Error(`${file} not found - run: npx tsx bot/jestDocs.ts`)
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

if (require.main === module) {
    scrapeJestDocs().then(d => console.log(`Saved ${d.length} entries to ${DOCS_FILE}`)).catch(e => {
        console.error(e)
        process.exit(1)
    })
}
