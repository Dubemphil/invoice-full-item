const express = require('express');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');
const dotenv = require('dotenv');

dotenv.config();

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64) {
    console.error("❌ GOOGLE_APPLICATION_CREDENTIALS_BASE64 is not set.");
    process.exit(1);
}

const credentials = JSON.parse(Buffer.from(process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64, 'base64').toString('utf-8'));
const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
google.options({ auth });

const sheets = google.sheets('v4');
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/scrape', async (req, res) => {
    try {
        console.log("📌 Using Google Sheet ID:", process.env.GOOGLE_SHEET_ID);
        const sheetId = process.env.GOOGLE_SHEET_ID;

        const { data } = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Sheet1!A:A',
        });

        if (!data.values) {
            console.warn("⚠️ No data found in Sheet1!");
            return res.json({ success: false, message: "No data in Sheet1" });
        }

        const browser = await puppeteer.launch({ 
            headless: true,
            ignoreHTTPSErrors: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--disable-software-rasterizer'
            ]
        });
        const page = await browser.newPage();
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        const rows = data.values;
        let extractedData = [];

        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
            const invoiceLink = rows[rowIndex][0];
            if (!invoiceLink || !/^https?:\/\//.test(invoiceLink)) {
                console.warn(`⚠️ Skipping invalid URL: ${invoiceLink}`);
                continue;
            }

            console.log(`🔄 Processing row ${rowIndex + 1} - ${invoiceLink}`);

            let navigationSuccess = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await page.goto(invoiceLink, { waitUntil: 'networkidle2', timeout: 30000 });
                    navigationSuccess = true;
                    break;
                } catch (navError) {
                    console.error(`❌ Attempt ${attempt} - Failed to navigate to ${invoiceLink}:`, navError);
                }
            }

            if (!navigationSuccess) {
                console.error(`❌ Skipping ${invoiceLink} after multiple failed attempts`);
                continue;
            }

            await new Promise(resolve => setTimeout(resolve, 3000));

            const invoiceData = await page.evaluate(() => {
                const items = [];
                const itemBlocks = document.querySelectorAll(".invoice-items-list div");

                itemBlocks.forEach((block) => {
                    const parts = block.innerText.trim().split('\n');
                    if (parts.length < 5) return;

                    const itemName = parts[0];
                    const unitPrice = parts[1].replace(' LEK', '').trim();
                    const totalPrice = parts[2].replace(' LEK', '').trim();
                    const quantity = parts[3].trim();
                    const extraDetail = parts[4].replace(' LEK', '').trim();
                    const vat = parts[5] ? parts[5].replace('VAT:', '').trim() : 'N/A';

                    items.push([itemName, unitPrice, totalPrice, quantity, extraDetail, vat]);
                });

                return items;
            });

            console.log(`✅ Extracted Data for row ${rowIndex + 1}:`, invoiceData);

            if (invoiceData.length === 0) {
                console.warn(`⚠️ No valid data extracted from ${invoiceLink}`);
                continue;
            }

            try {
                console.log(`📌 Updating Sheet2 with extracted data:`, invoiceData);
                await sheets.spreadsheets.values.append({
                    spreadsheetId: sheetId,
                    range: "Sheet2!C:H",
                    valueInputOption: "RAW",
                    resource: { values: invoiceData }
                });
            } catch (apiError) {
                console.error(`❌ Failed to update Google Sheets: ${apiError.message}`);
            }

            extractedData.push(invoiceData);
        }

        await browser.close();
        res.json({ success: true, message: "Scraping completed", data: extractedData });
    } catch (error) {
        console.error("❌ Error during scraping:", error);
        res.status(500).json({ success: false, message: "Scraping failed", error: error.toString() });
    }
});

app.listen(PORT, "0.0.0.0", () => console.log(`✅ Server running on port ${PORT}`));