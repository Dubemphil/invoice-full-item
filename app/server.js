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

        const sheetId = process.env.GOOGLE_SHEET_ID;
        const { data } = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Sheet1!A:A',
        });

        const rows = data.values;
        let currentRowSheet2 = 2;

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
                const itemRows = document.querySelectorAll(".invoice-items-list");

                itemRows.forEach((row) => {
                    const itemName = row.querySelector("div:nth-child(1)")?.innerText.trim() || "N/A";
                    const unitPrice = row.querySelector("div:nth-child(2)")?.innerText.replace(' LEK', '').trim() || "0";
                    const totalPrice = row.querySelector("div:nth-child(3)")?.innerText.replace(' LEK', '').trim() || "0";
                    const quantity = row.querySelector("div:nth-child(4)")?.innerText.trim() || "0";
                    const extraDetail = row.querySelector("div:nth-child(5)")?.innerText.replace(' LEK', '').trim() || "0";
                    const vat = row.querySelector("div:nth-child(6)")?.innerText.replace('VAT:', '').trim() || "N/A";

                    items.push([itemName, unitPrice, totalPrice, quantity, extraDetail, vat].slice(0, 6));
                });

                return items;
            });

            console.log(`✅ Extracted Data for row ${rowIndex + 1}:`, invoiceData);

            if (invoiceData.length === 0) {
                console.warn(`⚠️ No valid data extracted from ${invoiceLink}`);
                continue;
            }

            const updateValuesSheet2 = invoiceData.map(item => item.slice(0, 6));

            await sheets.spreadsheets.values.update({
                spreadsheetId: sheetId,
                range: `Sheet2!C${currentRowSheet2}:H${currentRowSheet2 + updateValuesSheet2.length - 1}`,
                valueInputOption: 'RAW',
                resource: { values: updateValuesSheet2 }
            });
            currentRowSheet2 += updateValuesSheet2.length;
        }

        await browser.close();
        res.json({ success: true, message: "Scraping completed" });
    } catch (error) {
        console.error("❌ Error during scraping:", error);
        res.status(500).json({ success: false, message: "Scraping failed", error: error.toString() });
    }
});

app.listen(PORT, "0.0.0.0", () => console.log(`✅ Server running on port ${PORT}`));
