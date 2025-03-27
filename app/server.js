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

        // Set page language to English
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        // Load invoice links from Sheet1
        const sheetId = process.env.GOOGLE_SHEET_ID;
        const { data } = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Sheet1!A:A',
        });

        const rows = data.values;
        let extractedData = [];
        let currentRow = 2; // Start writing from row 2 in Sheet2

        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
            const invoiceLink = rows[rowIndex][0];
            if (!invoiceLink || !/^https?:\/\//.test(invoiceLink)) {
                console.warn(`⚠️ Skipping invalid URL: ${invoiceLink}`);
                continue;
            }

            console.log(`🔄 Processing row ${rowIndex + 1} - ${invoiceLink}`);

            try {
                await page.goto(invoiceLink, { waitUntil: 'networkidle2', timeout: 30000 });
            } catch (navError) {
                console.error(`❌ Failed to navigate to ${invoiceLink}:`, navError);
                continue;
            }

            await new Promise(resolve => setTimeout(resolve, 3000));

            const invoiceData = await page.evaluate(() => {
                const getText = (xpath) => {
                    const element = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                    return element ? element.innerText.trim().replace('TVSH', 'VAT') : 'N/A';
                };

                const extractInvoiceNumber = () => {
                    const fullText = getText('/html/body/app-root/app-verify-invoice/div/section[1]/div/div[1]/h4');
                    const match = fullText.match(/\d+\/\d+/);
                    return match ? match[0] : 'N/A';
                };

                const extractItems = () => {
                    let items = [];
                    const showMoreBtn = document.querySelector("button.show-more");
                    if (showMoreBtn) {
                        showMoreBtn.click(); // Click "Show All" if available
                    }
                    
                    const itemNodes = document.evaluate("/html/body/app-root/app-verify-invoice/div/section[3]/div/ul/li/ul/li", document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
                    let currentNode = itemNodes.iterateNext();
                    while (currentNode) {
                        const itemParts = currentNode.innerText.trim().replace('TVSH', 'VAT').split('\n');
                        if (itemParts.length >= 3) {
                            items.push([itemParts[0], itemParts[1], itemParts[2]]); // Ensure proper formatting
                        } else {
                            items.push([itemParts[0], itemParts[1] || '', '']); // Handle missing price/total
                        }
                        currentNode = itemNodes.iterateNext();
                    }
                    return items;
                };

                return {
                    businessName: getText('/html/body/app-root/app-verify-invoice/div/section[1]/div/ul/li[1]'),
                    invoiceNumber: extractInvoiceNumber(),
                    items: extractItems()
                };
            });

            console.log(`✅ Extracted Data for row ${rowIndex + 1}:`, invoiceData);

            // Ensure first item list starts on the same row as business name and invoice number
            let updateValues = [[invoiceData.businessName, invoiceData.invoiceNumber, ...invoiceData.items[0] || ['', '', '']]];
            for (let i = 1; i < invoiceData.items.length; i++) {
                updateValues.push([null, null, ...invoiceData.items[i]]); // Ensure each item part is in its respective column
            }

            // Update Sheet2
            await sheets.spreadsheets.values.update({
                spreadsheetId: sheetId,
                range: `Sheet2!A${currentRow}:E${currentRow + updateValues.length - 1}`,
                valueInputOption: 'RAW',
                resource: { values: updateValues }
            });

            currentRow += updateValues.length; // Move to the next available row
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
