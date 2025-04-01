const express = require("express");
const { google } = require("googleapis");
const puppeteer = require("puppeteer");
const dotenv = require("dotenv");

dotenv.config();

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64) {
    console.error("❌ GOOGLE_APPLICATION_CREDENTIALS_BASE64 is not set.");
    process.exit(1);
}

// Authenticate Google Sheets
const credentials = JSON.parse(
    Buffer.from(process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64, "base64").toString("utf-8")
);
const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
google.options({ auth });

const sheets = google.sheets("v4");
const app = express();
const PORT = process.env.PORT || 8080;

const MAX_CONCURRENT_BROWSERS = 5; // Control concurrency

async function scrapeInvoice(invoiceLink) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--disable-software-rasterizer",
            ],
        });

        const page = await browser.newPage();
        await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

        // Retry navigation up to 3 times
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await page.goto(invoiceLink, { waitUntil: "networkidle2", timeout: 30000 });
                break;
            } catch (navError) {
                console.error(`❌ Attempt ${attempt} - Failed to navigate: ${invoiceLink}`, navError);
                if (attempt === 3) {
                    return { error: `Failed to load after 3 attempts`, url: invoiceLink };
                }
            }
        }

        await page.waitForTimeout(3000); // Ensure page fully loads

        const invoiceData = await page.evaluate(() => {
            const items = [];
            const itemBlocks = document.querySelectorAll(".invoice-items-list div");

            itemBlocks.forEach((block) => {
                const parts = block.innerText.trim().split("\n");
                if (parts.length < 5) return;

                const itemName = parts[0];
                const unitPrice = parts[1].replace(" LEK", "").trim();
                const totalPrice = parts[2].replace(" LEK", "").trim();
                const quantity = parts[3].trim();
                const extraDetail = parts[4].replace(" LEK", "").trim();
                const vat = parts[5] ? parts[5].replace("VAT:", "").trim() : "N/A";

                items.push([itemName, unitPrice, totalPrice, quantity, extraDetail, vat]);
            });

            return items;
        });

        return { url: invoiceLink, data: invoiceData.length ? invoiceData : null };
    } catch (error) {
        return { error: error.message, url: invoiceLink };
    } finally {
        if (browser) await browser.close();
    }
}

app.get("/scrape", async (req, res) => {
    try {
        const sheetId = process.env.GOOGLE_SHEET_ID;

        // Fetch URLs from Sheet1
        const { data } = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: "Sheet1!A:A",
        });

        const rows = data.values || [];
        if (rows.length === 0) {
            return res.json({ success: false, message: "No URLs found in Sheet1" });
        }

        // Filter out invalid URLs
        const validLinks = rows.map(row => row[0]).filter(url => /^https?:\/\//.test(url));
        if (validLinks.length === 0) {
            return res.json({ success: false, message: "No valid URLs found" });
        }

        console.log(`🔄 Scraping ${validLinks.length} URLs...`);

        // Process in batches of MAX_CONCURRENT_BROWSERS
        const extractedData = [];
        const failedUrls = [];

        for (let i = 0; i < validLinks.length; i += MAX_CONCURRENT_BROWSERS) {
            const batch = validLinks.slice(i, i + MAX_CONCURRENT_BROWSERS);
            const results = await Promise.all(batch.map(scrapeInvoice));

            results.forEach((result) => {
                if (result.error) {
                    failedUrls.push([result.url, result.error]);
                } else {
                    extractedData.push(...result.data.map(row => [result.url, ...row]));
                }
            });
        }

        // Update Sheet2 with extracted data
        if (extractedData.length > 0) {
            await sheets.spreadsheets.values.append({
                spreadsheetId: sheetId,
                range: "Sheet2!A:H",
                valueInputOption: "RAW",
                resource: { values: extractedData },
            });
        }

        // Update Sheet3 with failed URLs
        if (failedUrls.length > 0) {
            await sheets.spreadsheets.values.append({
                spreadsheetId: sheetId,
                range: "Sheet3!A:B",
                valueInputOption: "RAW",
                resource: { values: failedUrls },
            });
        }

        res.json({
            success: true,
            message: "Scraping completed",
            totalExtracted: extractedData.length,
            totalFailed: failedUrls.length,
        });
    } catch (error) {
        console.error("❌ Error during scraping:", error);
        res.status(500).json({ success: false, message: "Scraping failed", error: error.toString() });
    }
});

app.listen(PORT, "0.0.0.0", () => console.log(`✅ Server running on port ${PORT}`));
