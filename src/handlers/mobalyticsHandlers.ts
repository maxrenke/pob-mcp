/**
 * Guide Import Handlers (PoE1)
 *
 * import_from_mobalytics - scrape a Mobalytics PoE1 build guide and write it
 *                          to the PoB builds directory, delegating to the
 *                          guide2pob Python package (github.com/maxrenke/guide2pob).
 * import_from_pobbin     - download a shared build from pobb.in by URL or
 *                          build ID and save it to the builds directory.
 * upload_build_to_pobbin - encode any local PoB build and upload it to
 *                          pobb.in, returning a web link and protocol links
 *                          for both PoB1 and PoB2.
 *
 * Encoding/upload logic mirrors guide2pob (github.com/maxrenke/guide2pob)
 * without requiring the Python package as a dependency.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import zlib from "zlib";
import https from "https";
import { wrapHandler } from "../utils/errorHandling.js";
import { sanitizeBuildName } from "../utils/pathSanitizer.js";

const execFileAsync = promisify(execFile);

interface ImportContext {
  pobDirectory: string;
  buildService: { invalidateBuild: (name: string) => void };
}

interface UploadContext {
  pobDirectory: string;
}

/** Derive a filesystem-safe slug from a Mobalytics URL or any string. */
function buildNameFromUrl(url: string): string {
  const m = url.match(/\/builds\/([^/?#]+)/);
  const slug = m ? m[1] : "imported-build";
  return slug.replace(/[^a-zA-Z0-9_\- ]/g, "_").slice(0, 80);
}

/**
 * Import a Mobalytics PoE1 guide into the PoB builds directory.
 *
 * Shells out to `python -m guide2pob --game poe1`, captures the base64 import
 * code on stdout, decodes it to XML, and writes <pobDirectory>/<build_name>.xml.
 *
 * Requires the guide2pob package: pip install -e ~/repos/guide2pob
 */
export async function handleImportFromMobalytics(
  context: ImportContext,
  args: {
    url: string;
    merge?: boolean;
    variant?: string;
    build_name?: string;
    no_reorder?: boolean;
  }
) {
  return wrapHandler("import from Mobalytics", async () => {
    const { url } = args;
    const merge = args.merge ?? true;
    const variant = args.variant ?? "0";
    const noReorder = args.no_reorder ?? false;
    const buildName = (args.build_name || buildNameFromUrl(url)).trim();

    if (!buildName) throw new Error("build_name must not be empty");
    if (!url.startsWith("http")) throw new Error("url must start with http");

    const outputXml = sanitizeBuildName(buildName + ".xml", context.pobDirectory);

    const argv: string[] = ["-m", "guide2pob", url, "--game", "poe1"];
    if (merge) {
      argv.push("--merge");
      if (noReorder) argv.push("--no-reorder");
    } else {
      argv.push("--no-merge", "--variant", variant);
    }

    let stdout: string;
    let stderr: string;
    try {
      const result = await execFileAsync("python", argv, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60_000,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: any) {
      const msg = err.stderr?.trim() || err.message;
      throw new Error(`guide2pob failed: ${msg}`);
    }

    const code = stdout.trim();
    if (!code) throw new Error("guide2pob produced no output on stdout");

    let xml: string;
    try {
      xml = zlib.inflateSync(Buffer.from(code, "base64")).toString("utf-8");
    } catch {
      throw new Error("Could not decode guide2pob output - is the URL valid?");
    }

    // PoE1 root is <PathOfBuilding>, not <PathOfBuilding2>
    if (!xml.includes("<PathOfBuilding>") && !xml.includes("<PathOfBuilding ")) {
      throw new Error("Decoded output is not a valid PoB XML document");
    }

    await fs.writeFile(outputXml, xml, "utf-8");
    context.buildService.invalidateBuild(buildName + ".xml");

    const summaryLines = stderr
      .split("\n")
      .filter((l) => l.startsWith("# ") || l.startsWith("build:"))
      .join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Imported successfully!\n\n` +
            `File:   ${buildName}.xml\n` +
            `Source: ${url}\n` +
            (summaryLines ? `\n${summaryLines}\n` : "") +
            `\nUse analyze_build with "${buildName}.xml".`,
        },
      ],
    };
  });
}

/**
 * Encode a PoB XML string into a pobb.in-compatible URL-safe base64 code.
 * Matches moba2pob's encode() + _to_urlsafe() pipeline.
 */
function encodeXml(xml: string): string {
  const compressed = zlib.deflateSync(Buffer.from(xml, "utf-8"), { level: 9 });
  return compressed
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Download a build code from pobb.in by build ID.
 * Protocol: GET /pob/<id> returns the URL-safe base64 code as plain text.
 * Symmetric reverse of the upload (POST /pob/).
 */
async function downloadFromPobbin(id: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "pobb.in",
        path: `/pob/${id}`,
        method: "GET",
        headers: {
          "User-Agent": "pob-mcp (+https://github.com/maxrenke/pob-mcp)",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `pobb.in returned HTTP ${res.statusCode}: ${data.slice(0, 200)}`
              )
            );
            return;
          }
          const code = data.trim();
          if (!code) {
            reject(new Error("pobb.in returned empty body"));
            return;
          }
          resolve(code);
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Upload a build code to pobb.in.
 * Protocol: POST the URL-safe base64 code as plain text; response body is the
 * build ID. Mirrors moba2pob's upload.py without requiring the Python package.
 */
async function uploadToPobbin(
  code: string
): Promise<{ id: string; url: string; pob2_url: string; pob_url: string }> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(code, "ascii");
    const req = https.request(
      {
        hostname: "pobb.in",
        path: "/pob/",
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": body.length,
          "User-Agent": "pob-mcp (+https://github.com/maxrenke/pob-mcp)",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `pobb.in returned HTTP ${res.statusCode}: ${data.slice(0, 200)}`
              )
            );
            return;
          }
          const id = data.trim();
          if (!id || id.includes("/") || id.length > 64) {
            reject(new Error(`Unexpected pobb.in response: ${JSON.stringify(id)}`));
            return;
          }
          resolve({
            id,
            url: `https://pobb.in/${id}`,
            pob2_url: `pob2://pobbin/${id}`,
            pob_url: `pob://pobbin/${id}`,
          });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Download a shared build from pobb.in and save it to the builds directory.
 */
export async function handleImportFromPobbin(
  context: UploadContext,
  args: { url_or_id: string; build_name?: string }
) {
  return wrapHandler("import from pobb.in", async () => {
    const input = args.url_or_id.trim();
    const idMatch = input.match(/pobb\.in\/([A-Za-z0-9_-]+)/);
    const id = idMatch ? idMatch[1] : input;
    if (!id || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error(
        "Invalid build ID. Pass a full pobb.in URL or a bare build ID (e.g. AbCdEfGh)."
      );
    }

    const buildName = (args.build_name || id).trim();
    if (!buildName) throw new Error("build_name must not be empty");

    const outputXml = sanitizeBuildName(buildName + ".xml", context.pobDirectory);

    const urlSafeCode = await downloadFromPobbin(id);
    const stdCode = urlSafeCode.replace(/-/g, "+").replace(/_/g, "/");

    let xml: string;
    try {
      xml = zlib.inflateSync(Buffer.from(stdCode, "base64")).toString("utf-8");
    } catch {
      throw new Error("Could not decode pobb.in response - is the build ID valid?");
    }

    if (!xml.includes("<PathOfBuilding") || !xml.includes("<Build")) {
      throw new Error("Downloaded data is not a valid PoB XML document");
    }

    await fs.writeFile(outputXml, xml, "utf-8");

    const isPoE2 = xml.includes("<PathOfBuilding2>");
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Build imported from pobb.in!\n\n` +
            `File:   ${buildName}.xml\n` +
            `Source: https://pobb.in/${id}\n` +
            `Game:   ${isPoE2 ? "Path of Exile 2" : "Path of Exile 1"}\n` +
            `\nUse analyze_build with "${buildName}.xml".`,
        },
      ],
    };
  });
}

/**
 * Upload a local PoB build to pobb.in and return the shareable links.
 *
 * Reads the XML from <pobDirectory>/<build_name>, encodes it with zlib+base64,
 * and POSTs it to pobb.in. No external dependencies required.
 */
export async function handleUploadToPobbin(
  context: UploadContext,
  args: { build_name: string }
) {
  return wrapHandler("upload to pobb.in", async () => {
    const buildPath = sanitizeBuildName(args.build_name, context.pobDirectory);
    const xml = await fs.readFile(buildPath, "utf-8");

    const code = encodeXml(xml);
    const info = await uploadToPobbin(code);

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Build uploaded to pobb.in!\n\n` +
            `Web:       ${info.url}\n` +
            `Open PoB2: ${info.pob2_url}\n` +
            `Open PoB1: ${info.pob_url}`,
        },
      ],
    };
  });
}
