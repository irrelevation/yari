import { Doc } from "../libs/types";
import fs from "fs";
import path from "path";

import chalk from "chalk";
import {
  MacroLiveSampleError,
  MacroRedirectedLinkError,
} from "../kumascript/src/errors";

import { Document, Image, execGit } from "../content";
import { CONTENT_ROOT, REPOSITORY_URLS } from "../libs/env";
import * as kumascript from "../kumascript";

import { FLAW_LEVELS } from "../libs/constants";
import {
  extractSections,
  extractSidebar,
  extractSummary,
} from "./document-extractor";
export { default as SearchIndex } from "./search-index";
import { addBreadcrumbData } from "./document-utils";
import { fixFixableFlaws, injectFlaws, injectSectionFlaws } from "./flaws";
import { normalizeBCDURLs, extractBCDData, BCDData } from "./bcd-urls";
import { checkImageReferences, checkImageWidths } from "./check-images";
import { getPageTitle } from "./page-title";
import { syntaxHighlight } from "./syntax-highlight";
import { formatNotecards } from "./format-notecards";
import buildOptions from "./build-options";
export { gather as gatherGitHistory } from "./git-history";
export { buildSPAs } from "./spas";
import LANGUAGES_RAW from "../libs/languages";
import { safeDecodeURIComponent } from "../kumascript/src/api/util";
import { wrapTables } from "./wrap-tables";

const LANGUAGES = new Map(
  Object.entries(LANGUAGES_RAW).map(([locale, data]) => {
    return [locale.toLowerCase(), data];
  })
);

const DEFAULT_BRANCH_NAME = "main"; // That's what we use for github.com/mdn/content

// Module-level cache
const rootToGitBranchMap = new Map();

function getCurrentGitBranch(root) {
  if (!rootToGitBranchMap.has(root)) {
    // If this is running in a GitHub Action "PR Build" workflow the current
    // branch name will be set in `GITHUB_REF_NAME_SLUG`.
    let name = DEFAULT_BRANCH_NAME;
    // Only bother getting fancy if the root is CONTENT_ROOT.
    // For other possible roots, just leave it to the default.
    if (root === CONTENT_ROOT) {
      if (process.env.GITHUB_REF) {
        name = process.env.GITHUB_REF.split("/").slice(2).join("/");
      } else {
        // Most probably, you're hacking on the content, using Yari to preview,
        // in a topic branch. Then figure this out using a child-process.
        // Note, if you're in detached head, (e.g. "d6a6c3f17") instead of a named
        // branch, this will fail. But that's why we rely on a default.
        try {
          const output = execGit(["branch", "--show-current"], {
            cwd: root,
          });
          if (output) {
            name = output;
          }
        } catch (e) {
          /* allowed to fail for non git content root */
        }
      }
    }

    rootToGitBranchMap.set(root, name);
  }
  return rootToGitBranchMap.get(root);
}

/** Throw an error if the slug is insane.
 * This helps breaking the build if someone has put in faulty data into
 * the content (metadata file).
 * If all is well, do nothing. Nothing is expected to return.
 */
function validateSlug(slug) {
  if (!slug) {
    throw new Error("slug is empty");
  }
  if (slug.startsWith("/")) {
    throw new Error(`Slug '${slug}' starts with a /`);
  }
  if (slug.endsWith("/")) {
    throw new Error(`Slug '${slug}' ends with a /`);
  }
  if (slug.includes("//")) {
    throw new Error(`Slug '${slug}' contains a double /`);
  }
}

/**
 * Find all tags that we need to change to tell tools like Google Translate
 * to not translate.
 *
 * @param {Cheerio document instance} $
 */
function injectNoTranslate($) {
  $("pre").addClass("notranslate");
}

/**
 * For every image and iframe, where appropriate add the `loading="lazy"` attribute.
 *
 * @param {Cheerio document instance} $
 */
function injectLoadingLazyAttributes($) {
  $("img:not([loading]), iframe:not([loading])").attr("loading", "lazy");
}

/**
 * For every `<a href="http...">` make it
 * `<a href="http..." class="external" and rel="noopener">`
 *
 *
 * @param {Cheerio document instance} $
 */
function postProcessExternalLinks($) {
  $("a[href^=http]").each((i, element) => {
    const $a = $(element);
    if ($a.attr("href").startsWith("https://developer.mozilla.org")) {
      // This should have been removed since it's considered a flaw.
      // But we haven't applied all fixable flaws yet and we still have to
      // support translated content which is quite a long time away from
      // being entirely treated with the fixable flaws cleanup.
      return;
    }
    $a.addClass("external");
    const rel = ($a.attr("rel") || "").split(" ");
    if (!rel.includes("noopener")) {
      rel.push("noopener");
      $a.attr("rel", rel.join(" "));
    }
  });
}

/**
 * For every `<a href="THING">`, where 'THING' is not a http or / link, make it
 * `<a href="$CURRENT_PATH/THING">`
 *
 *
 * @param {Cheerio document instance} $
 */
function postLocalFileLinks($, doc) {
  $("a[href]").each((i, element) => {
    const href = element.attribs.href;

    // This test is merely here to quickly bail if there's no hope to find the
    // image as a local file link. There are a LOT of hyperlinks throughout
    // the content and this simple if statement means we can skip 99% of the
    // links, so it's presumed to be worth it.
    if (
      !href ||
      /^(\/|\.\.|http|#|mailto:|about:|ftp:|news:|irc:|ftp:)/i.test(href)
    ) {
      return;
    }
    // There are a lot of links that don't match. E.g. `<a href="SubPage">`
    // So we'll look-up a lot "false positives" that are not images.
    // Thankfully, this lookup is fast.
    const url = `${doc.mdn_url}/${href}`;
    const image = Image.findByURLWithFallback(url);
    if (image) {
      $(element).attr("href", url);
    }
  });
}

/**
 * Fix the heading IDs so they're all lower case.
 *
 * @param {Cheerio document instance} $
 */
function postProcessSmallerHeadingIDs($) {
  $("h4[id], h5[id], h6[id]").each((i, element) => {
    const id = element.attribs.id;
    const lcID = id.toLowerCase();
    if (id !== lcID) {
      $(element).attr("id", lcID);
    }
  });
}

/**
 * Find all `<div class="warning">` and turn them into `<div class="warning notecard">`
 * and keep in mind that if it was already been manually fixed so, you
 * won't end up with `<div class="warning notecard notecard">`.
 *
 * @param {Cheerio document instance} $
 */
function injectNotecardOnWarnings($) {
  $("div.warning, div.note, div.blockIndicator")
    .addClass("notecard")
    .removeClass("blockIndicator");
}

/**
 * Return the full URL directly to the file in GitHub based on this folder.
 * @param {String} folder - the current folder we're processing.
 */
function getGitHubURL(root, folder, filename) {
  const baseURL = `https://github.com/${REPOSITORY_URLS[root]}`;
  return `${baseURL}/blob/${getCurrentGitBranch(
    root
  )}/files/${folder}/${filename}`;
}

/**
 * Return the full URL directly to the last commit affecting this file on GitHub.
 * @param {String} hash - the full hash to point to.
 */
export function getLastCommitURL(root, hash) {
  const baseURL = `https://github.com/${REPOSITORY_URLS[root]}`;
  return `${baseURL}/commit/${hash}`;
}

function injectSource(doc, document, metadata) {
  const folder = document.fileInfo.folder;
  const root = document.fileInfo.root;
  const filename = path.basename(document.fileInfo.path);
  doc.source = {
    folder,
    github_url: getGitHubURL(root, folder, filename),
    last_commit_url: getLastCommitURL(root, metadata.hash),
    filename,
  };
}

/**
 * Return an array of objects like this [{text: ..., id: ...}, ...]
 * from a document's body.
 * This will be used for the "Table of Contents" menu which expects to be able
 * to link to each section with anchor links.
 *
 * @param {Document} doc
 */
function makeTOC(doc) {
  return doc.body
    .map((section) => {
      if (
        (section.type === "prose" ||
          section.type === "browser_compatibility" ||
          section.type === "specifications") &&
        section.value.id &&
        section.value.title &&
        !section.value.isH3
      ) {
        return { text: section.value.title, id: section.value.id };
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * Return an array of all images that are inside the documents source folder.
 *
 * @param {Document} document
 */
function getAdjacentImages(documentDirectory) {
  const dirents = fs.readdirSync(documentDirectory, { withFileTypes: true });
  return dirents
    .filter((dirent) => {
      // This needs to match what we do in filecheck/checker.py
      return (
        !dirent.isDirectory() &&
        /\.(png|jpeg|jpg|gif|svg|webp)$/i.test(dirent.name)
      );
    })
    .map((dirent) => path.join(documentDirectory, dirent.name));
}

export interface BuiltDocument {
  doc: Doc;
  liveSamples: any;
  fileAttachments: any;
  bcdData: BCDData[];
  source?: {
    github_url: string;
  };
}

interface DocumentOptions {
  fixFlaws?: boolean;
  fixFlawsVerbose?: boolean;
}

export async function buildDocument(
  document,
  documentOptions: DocumentOptions = {}
): Promise<BuiltDocument> {
  // Important that the "local" document options comes last.
  // And use Object.assign to create a new object instead of mutating the
  // global one.
  const options = {
    ...buildOptions,
    ...documentOptions,
  };
  const { metadata, fileInfo } = document;

  if (Document.urlToFolderPath(document.url) !== document.fileInfo.folder) {
    throw new Error(
      `The document's slug (${metadata.slug}) doesn't match its disk folder name (${document.fileInfo.folder})`
    );
  }

  const doc = {
    isMarkdown: document.isMarkdown,
    isTranslated: document.isTranslated,
    isActive: document.isActive,
    flaws: {},
  } as Partial<Doc>;

  interface LiveSample {
    id: string;
    html: string;
  }

  let flaws: any[] = [];
  let $ = null;
  const liveSamples: LiveSample[] = [];

  try {
    [$, flaws] = await kumascript.render(document.url);
  } catch (error) {
    if (error.name === "MacroInvocationError") {
      // The source HTML couldn't even be parsed! There's no point allowing
      // anything else move on.
      // But considering that this might just be one of many documents you're
      // building, let's at least help by setting a more user-friendly error
      // message.
      error.updateFileInfo(document.fileInfo);
      throw new Error(
        `MacroInvocationError trying to parse ${error.filepath}, line ${error.line} column ${error.column} (${error.error.message})`
      );
    }
    // Any other unexpected error re-thrown.
    throw error;
  }

  const liveSamplePages = kumascript.buildLiveSamplePages(
    document.url,
    document.metadata.title,
    $,
    document.rawBody
  );
  for (let { id, html, flaw } of liveSamplePages) {
    if (flaw) {
      flaw.updateFileInfo(fileInfo);
      if (flaw.name === "MacroLiveSampleError") {
        // As of April 2021 there are 0 pages in mdn/content that trigger
        // a MacroLiveSampleError. So we can be a lot more strict with en-US
        // until the translated-content has had a chance to clean up all
        // their live sample errors.
        // See https://github.com/mdn/yari/issues/2489
        if (document.metadata.locale === "en-US") {
          throw new Error(
            `MacroLiveSampleError within ${flaw.filepath}, line ${flaw.line} column ${flaw.column} (${flaw.error.message})`
          );
        } else {
          console.warn(
            `MacroLiveSampleError within ${flaw.filepath}, line ${flaw.line} column ${flaw.column} (${flaw.error.message})`
          );
        }
      }
      flaws.push(flaw);
      html = `<!doctype html>
        <html>
          <head>
            <meta charset="utf-8">
            <title>Live sample failed!</title>
            <style type="text/css">
              body {
                background-color: #fae4e5;
              }
            </style>
          </head>
          <body>
            <h1>Live sample failed!</h1>
            <p>
              An error occurred trying to render this live sample.
              <br>
              Consider filing an issue or trying your hands at a fix of your own.
            </p>
            <p><b>Error details:</b></p>
            <p>
              <code>${flaw.error.toString()}</code>
            </p>
          </body>
        </html>
        `;
    }
    liveSamples.push({ id: id.toLowerCase(), html });
  }

  if (flaws.length) {
    if (options.flawLevels.get("macros") === FLAW_LEVELS.ERROR) {
      // Report and exit immediately on the first document with flaws.
      console.error(
        chalk.red.bold(
          `Flaws (${flaws.length}) within ${document.metadata.slug} while rendering macros:`
        )
      );
      flaws.forEach((flaw, i) => {
        console.error(chalk.bold.red(`${i + 1}: ${flaw.name}`));
        console.error(chalk.red(`${flaw}\n`));
      });
      // // XXX This is probably the wrong way to bubble up.
      // process.exit(1);
      throw new Error("Flaw error encountered");
    } else if (options.flawLevels.get("macros") === FLAW_LEVELS.WARN) {
      // doc.flaws.macros = flaws;
      // The 'flaws' array don't have everything we need from the
      // kumascript rendering, so we "beef it up" to have convenient
      // attributes needed.
      doc.flaws = doc.flaws ?? {};
      doc.flaws.macros = flaws.map((flaw: any, i) => {
        let fixable = false;
        let suggestion: string | null = null;
        if (flaw.name === "MacroDeprecatedError") {
          fixable = true;
          suggestion = "";
        } else if (
          flaw.name === "MacroRedirectedLinkError" &&
          (!(flaw as MacroRedirectedLinkError).filepath ||
            (flaw as MacroRedirectedLinkError).filepath ===
              document.fileInfo.path)
        ) {
          fixable = true;
          suggestion = (flaw as MacroRedirectedLinkError).macroSource.replace(
            (flaw as MacroRedirectedLinkError).redirectInfo.current,

            (flaw as MacroRedirectedLinkError).redirectInfo.suggested
          );
        }
        const id = `macro${i}`;
        const explanation = flaw.error.message;
        return Object.assign({ id, fixable, suggestion, explanation }, flaw);
      });
    }
  }

  // TODO: The slug should always match the folder name.
  // If you edit the slug bug don't correctly edit the folder it's in
  // it's going to lead to confusion.
  // We can use the utils.slugToFolder() function and compare
  // its output with the `folder`.
  validateSlug(metadata.slug);

  // EmbedLiveSamples carry their token information to enrich flaw error
  // messages, these should not be in the final output
  $("[data-token]").removeAttr("data-token");

  // Kumascript rendering can't know about FLAW_LEVELS when it's building,
  // because injecting it there would cause a circular dependency.
  // So, let's post-process the rendered HTML now afterwards.
  // If the flaw levels for `macros` was to ignore, we can delete all the
  // injected `data-flaw-src="..."` attributes.
  if (options.flawLevels.get("macros") === FLAW_LEVELS.IGNORE) {
    // This helps the final production built HTML since there `data-flaw-src`
    // attributes on the HTML is useless.
    $("[data-flaw-src]").removeAttr("data-flaw-src");
  }

  doc.title = metadata.title || "";
  doc.mdn_url = document.url;
  doc.locale = metadata.locale as string;
  doc.native = LANGUAGES.get(doc.locale.toLowerCase())?.native;

  // If the document contains <math> HTML, it will set `doc.hasMathML=true`.
  // The client (<Document/> component) needs to know this for loading polyfills.
  if ($("math").length > 0) {
    doc.hasMathML = true;
  }

  // Note that 'extractSidebar' will always return a string.
  // And if it finds a sidebar section, it gets removed from '$' too.
  // Also note, these operations mutate the `$`.
  extractSidebar($, doc);

  // Check and scrutinize any local image references
  const fileAttachments = checkImageReferences(doc, $, options, document);
  // Not all images are referenced as `<img>` tags. Some are just sitting in the
  // current document's folder and they might be referenced in live samples.
  // The checkImageReferences() does 2 things. Checks image *references* and
  // it returns which images it checked. But we'll need to complement any
  // other images in the folder.
  getAdjacentImages(path.dirname(document.fileInfo.path)).forEach((fp) =>
    fileAttachments.add(fp)
  );

  // Check the img tags for possible flaws and possible build-time rewrites
  checkImageWidths(doc, $, options, document);

  // With the sidebar out of the way, go ahead and check the rest
  try {
    injectFlaws(doc, $, options, document);
  } catch (error) {
    console.warn(
      `Injecting flaws into ${document.fileInfo.path} (${document.url}) failed.`
    );
    throw error;
  }

  // If fixFlaws is on and the doc has fixable flaws, this returned
  // raw HTML string will be different.
  try {
    await fixFixableFlaws(doc, options, document);
  } catch (error) {
    console.error(error);
    throw error;
  }

  // Now that live samples have been extracted, lets remove all the `div.hidden` tags
  // that were used for that. If we don't do this, for example, the `pre` tags will be
  // syntax highligted, which is a waste because they're going to be invisible
  // anyway.
  $("div.hidden").remove();

  // Apply syntax highlighting all <pre> tags.
  syntaxHighlight($, doc);

  // Post process HTML so that the right elements gets tagged so they
  // *don't* get translated by tools like Google Translate.
  injectNoTranslate($);

  // Add the `loading=lazy` HTML attribute to the appropriate elements.
  injectLoadingLazyAttributes($);

  // All external hyperlinks should have the `external` class name.
  postProcessExternalLinks($);

  // All internal hyperlinks to a file should become "absolute" URLs
  postLocalFileLinks($, doc);

  // Since all anchor links are forced into lower case, and `<h2>` and `<h3>`
  // is taken care of by the React rendering itself, we have to post-process
  // any possible headings whose ID might not be perfect.
  // The reason we can't do this as part of the kumascript rendering is because
  // the old
  postProcessSmallerHeadingIDs($);

  // All content that uses `<div class="warning">` needs to become
  // `<div class="warning notecard">` instead.
  // Some day, we can hopefully do a mass search-and-replace so we never
  // need to do this code here.
  // We might want to delete this injection in 2021 some time when all content's
  // raw HTML has been fixed to always have it in there already.
  injectNotecardOnWarnings($);

  formatNotecards($);

  wrapTables($);

  // Turn the $ instance into an array of section blocks. Most of the
  // section blocks are of type "prose" and their value is a string blob
  // of HTML.
  try {
    const [sections, sectionFlaws] = extractSections($);
    doc.body = sections;
    if (sectionFlaws.length) {
      injectSectionFlaws(doc, sectionFlaws, options);
    }
  } catch (error) {
    // If you run `yarn build` and an error is thrown inside `extractSections()`
    // you won't know which file it was in the middle processing because
    // the error won't be able to mention that.
    // So we catch the error, log which file it happened to and then
    // rethrow the error. Now you get a clue at least as to where to look.
    console.error(
      `Extracting sections failed in ${doc.mdn_url} (${document.fileInfo.path})`
    );
    throw error;
  }

  // Extract all the <h2> tags as they appear into an array.
  doc.toc = makeTOC(doc);

  // The summary comes from the HTML and potentially the <h2>Summary</h2>
  // section. It's always a plain text string.
  doc.summary = extractSummary(doc.body);

  // Creates new mdn_url's for the browser-compatibility-table to link to
  // pages within this project rather than use the absolute URLs
  normalizeBCDURLs(doc as Doc, options);

  const bcdData = extractBCDData(doc as Doc);

  // If the document has a `.popularity` make sure don't bother with too
  // many significant figures on it.
  doc.popularity = metadata.popularity
    ? Number(metadata.popularity.toFixed(4))
    : 0.0;

  doc.modified = metadata.modified || null;

  const otherTranslations = document.translations || [];
  if (!otherTranslations.length && metadata.translation_of) {
    // If built just-in-time, we won't have a record of all the other translations
    // available. But if the current document has a translation_of, we can
    // at least use that.
    const translationOf = Document.findByURL(
      `/en-US/docs/${metadata.translation_of}`
    );
    if (translationOf) {
      otherTranslations.push({
        locale: "en-US",
        title: translationOf.metadata.title,
        native: LANGUAGES.get("en-us")?.native,
      });
    }
  }

  if (otherTranslations.length) {
    doc.other_translations = otherTranslations;
  }

  injectSource(doc, document, metadata);

  // The `titles` object should contain every possible URI->Title mapping.
  // We can use that generate the necessary information needed to build
  // a breadcrumb in the React component.
  addBreadcrumbData(document.url, doc);

  doc.pageTitle = getPageTitle(doc);

  // Decide whether it should be indexed (sitemaps, robots meta tag, search-index)
  doc.noIndexing =
    metadata.slug === "MDN/Kitchensink" ||
    document.metadata.slug.startsWith("orphaned/") ||
    document.metadata.slug.startsWith("conflicting/");

  return { doc: doc as Doc, liveSamples, fileAttachments, bcdData };
}

interface BuiltLiveSamplePage {
  id: string;
  html: string | null;
  flaw: MacroLiveSampleError | null;
}

export async function buildLiveSamplePageFromURL(url) {
  // The 'url' is expected to be something
  // like '/en-us/docs/foo/bar/_sample_.myid.html' and from that we want to
  // extract '/en-us/docs/foo/bar' and 'myid'. But only if it matches.
  if (!url.endsWith(".html") || !url.includes("/_sample_.")) {
    throw new Error(`Unexpected URL format to extract live sample ('${url}')`);
  }
  const [documentURL, sampleID] = url.split(/\.html$/)[0].split("/_sample_.");
  const decodedSampleID = safeDecodeURIComponent(sampleID).toLowerCase();
  const document = Document.findByURL(documentURL);
  if (!document) {
    throw new Error(`No document found for ${documentURL}`);
  }
  const liveSamplePage = (
    kumascript.buildLiveSamplePages(
      document.url,
      document.metadata.title,
      (await kumascript.render(document.url))[0],
      document.rawBody
    ) as BuiltLiveSamplePage[]
  ).find((page) => page.id.toLowerCase() == decodedSampleID);

  if (liveSamplePage) {
    if (liveSamplePage.flaw) {
      throw new Error(liveSamplePage.flaw.toString());
    }
    return liveSamplePage.html;
  }

  throw new Error(
    `No live-sample "${decodedSampleID}" found within ${documentURL}`
  );
}

// This is used by the builder (yarn build) and by the server (JIT).
// Someday, this function might change if we decide to include the list
// of GitHub usernames that have contributed to it since it moved to GitHub.
export function renderContributorsTxt(
  wikiContributorNames: string[] | null = null,
  githubURL: string | null = null
) {
  let txt = "";
  if (githubURL) {
    // Always show this first
    txt += `# Contributors by commit history\n${githubURL}\n\n`;
  }
  if (wikiContributorNames) {
    txt += `# Original Wiki contributors\n${wikiContributorNames.join("\n")}\n`;
  }
  return txt;
}
