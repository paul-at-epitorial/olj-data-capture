const puppeteer = require('puppeteer');

// Paste your actual URLs here
const GOOGLE_SHEET_WEB_APP = 'https://script.google.com/macros/s/AKfycbzSeUYpWgKRMdWRTFKm88v08bK7D86uOkBK0nwX_JIkg39AJM9kKb2d6k6lS1Mqag5I/exec';
const DISCORD_WEBHOOK = 'https://va-job-bot.onrender.com/new-job';

(async () => {
  console.log('Launching browser in cloud mode...');
  // headless: true is required for GitHub Actions
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  await page.setViewport({ width: 1920, height: 1080 });

  // 1. Go directly to the main job board (Guest Mode)
  console.log('Loading OnlineJobs.ph...');
  await page.goto('https://www.onlinejobs.ph/jobseekers/jobsearch', { waitUntil: 'networkidle2' });
  
  // 2. Grab URLs AND Timestamps from the main board
  const jobListings = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.jobpost-cat-box')); 
    
    return cards.map(card => {
      const linkEl = card.querySelector('a');
      const timeEl = card.querySelector('em'); 
      
      return {
        url: linkEl ? linkEl.href : null,
        postedTime: timeEl ? timeEl.innerText.replace('Posted on ', '').trim() : 'Time not found'
      };
    }).filter(job => job.url && job.url.includes('/jobseekers/job/'));
  });

  // Remove duplicates 
  const uniqueListings = [...new Map(jobListings.map(item => [item.url, item])).values()];
  console.log(`Found ${uniqueListings.length} jobs. Processing...`);

  // 3. Loop through the listings
  for (let listing of uniqueListings) {
    const link = listing.url;
    let rawTime = listing.postedTime; 
    
    // Safety split to get true ID even if the URL structure shifts slightly
    const jobId = link.split('/').pop().split('-').pop(); 

    // Date Formatter: Converts "2026-04-19 09:46:39" to "Apr-19-26 at 9:46:39 am"
    let displayTime = rawTime;
    if (displayTime !== 'Time not found') {
      const d = new Date(displayTime);
      if (!isNaN(d)) {
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const dateStr = `${months[d.getMonth()]}-${String(d.getDate()).padStart(2, '0')}-${String(d.getFullYear()).slice(-2)}`;
        const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).toLowerCase();
        displayTime = `${dateStr} at ${timeStr}`;
      }
    }

    // 4. Ping Google Sheets to check for ID duplicates
    try {
      const checkRes = await fetch(GOOGLE_SHEET_WEB_APP, {
        method: 'POST',
        body: JSON.stringify({ action: 'check_id', jobId: jobId }),
        headers: { 'Content-Type': 'application/json' }
      });
      const checkData = await checkRes.json();

      if (checkData.status === 'duplicate') {
        console.log(`[SKIPPED] Job ${jobId} is already in the database.`);
        continue;
      }
    } catch (err) {
      console.log(`Error checking Google Sheets for ${jobId}:`, err);
      continue;
    }

    // 5. If it is new, open the actual job post to get the deep details
    console.log(`[NEW] Extracting data for Job ${jobId}...`);
    await page.goto(link, { waitUntil: 'domcontentloaded' });

    // Extract the text using DOM selectors
    const jobData = await page.evaluate(() => {
      
      // Helper function to grab text and clean up OLJ's corrupted emojis (????)
      const cleanText = (text) => {
        return text ? text.replace(/\?{2,}/g, '').trim() : 'N/A';
      };

      const getText = (selector) => {
        const el = document.querySelector(selector);
        return cleanText(el ? el.innerText : 'N/A');
      };
      
      const getSiblingText = (labelText) => {
        const headers = Array.from(document.querySelectorAll('h3, dt, strong, span, p')); 
        const target = headers.find(h => h.innerText.trim().toUpperCase().includes(labelText.toUpperCase()));
        return cleanText(target && target.nextElementSibling ? target.nextElementSibling.innerText : 'N/A');
      };
      
      let rawDesc = getText('#job-description');
      // Remove excessive line breaks to keep the paragraph compact
      rawDesc = rawDesc.replace(/\n{3,}/g, '\n\n');
      
      // Smart Truncation: Cut at ~450 chars, but stop at the last whole word so it doesn't chop mid-sentence
      let finalDesc = rawDesc;
      if (rawDesc.length > 450) {
        finalDesc = rawDesc.substring(0, 450);
        finalDesc = finalDesc.substring(0, finalDesc.lastIndexOf(" ")) + '...';
      }

      return {
        title: getText('h1'), 
        salary: getSiblingText('WAGE / SALARY'),
        type: getSiblingText('TYPE OF WORK'),
        hours: getSiblingText('HOURS PER WEEK'),
        description: finalDesc
      };
    });

    // Format the Hours (Issue #3)
    let displayHours = jobData.hours;
    // If it contains a number, but DOES NOT contain the word 'hour' or 'hrs'
    if (/\d/.test(displayHours) && !/hour|hrs/i.test(displayHours)) {
        displayHours += " hours";
    }

    // Check for closed or deleted job posts
    const statusCheck = (jobData.title + " " + jobData.description).toLowerCase();
    if (statusCheck.includes("has been closed") || statusCheck.includes("no longer posted") || statusCheck.includes("has been deleted") || statusCheck.includes("no longer visible") || statusCheck.includes("no longer available")) {
        console.log(`[SKIPPED] Job ${jobId} is closed or deleted.`);
        continue;
    }

    // 5.5 Send description to Sheet (Column C) and check for copy-paste duplicates
    try {
        const saveRes = await fetch(GOOGLE_SHEET_WEB_APP, {
            method: 'POST',
            // Notice we added jobLink: link right here
            body: JSON.stringify({ action: 'save', jobId: jobId, jobLink: link, description: jobData.description }),
            headers: { 'Content-Type': 'application/json' }
        });
        const saveData = await saveRes.json();

        if (saveData.status === 'duplicate') {
            console.log(`[SKIPPED] Job ${jobId} is a duplicate description of past post ${saveData.duplicateId}.`);
            continue;
        }
    } catch (err) {
        console.log(`Error saving Google Sheets data for ${jobId}:`, err);
        continue;
    }

    // 6. Sort the job into a category using comprehensive arrays
    const searchText = (jobData.title + " " + jobData.description).toLowerCase();
    
    const kwSystems = ['gohighlevel', 'ghl', 'zapier', 'make.com', 'api', 'automation', 'webhook', 'crm', 'activecampaign', 'hubspot', 'systems'];
    const kwMarketing = ['marketing', 'seo', 'social media', 'campaign', 'media buyer', 'facebook ads', 'google ads', 'lead gen', 'outreach', 'cold call', 'email', 'tiktok', 'instagram'];
    const kwEcom = ['amazon', 'fba', 'dropship', 'shopify', 'ecommerce', 'e-commerce', 'product research', 'sourcing', 'seller central', 'walmart', 'arbitrage'];
    const kwCreative = ['video', 'editor', 'design', 'graphic', 'thumbnail', 'premiere', 'after effects', 'photoshop', 'illustrator', 'canva', 'copywrit', 'ui/ux', 'blog', 'midjourney', 'runway'];
    const kwTech = ['tech', 'developer', 'code', 'it support', 'web', 'software', 'programmer', 'python', 'javascript'];
    const kwManagement = ['manage', 'director', 'lead', 'supervisor', 'head of'];
    
    let category = "admin-va"; // Default fallback if no keywords match

    if (kwCreative.some(kw => searchText.includes(kw))) category = "creative-va";
    else if (kwEcom.some(kw => searchText.includes(kw))) category = "ecom-va";
    else if (kwMarketing.some(kw => searchText.includes(kw))) category = "marketing-va";
    else if (kwSystems.some(kw => searchText.includes(kw))) category = "automations-va";
    else if (kwTech.some(kw => searchText.includes(kw))) category = "tech-va";
    else if (kwManagement.some(kw => searchText.includes(kw))) category = "management-va";

    // 7. Format the payload for the Render Bot
    // Wrapping the link in < > hides Discord's ugly automated link preview box
    const richTitle = `${jobData.title}**\n\n💰 **Salary:** ${jobData.salary}\n🕒 **Type:** ${jobData.type} | ${displayHours}\n📝 **Description:**\n${jobData.description}`;

    const renderPayload = {
      jobCategoryKey: category,
      jobTitle: richTitle,
      jobLink: `<${link}>`
    };

    // 8. Fire it to the Render server
    try {
      const res = await fetch(DISCORD_WEBHOOK, {
        method: 'POST',
        body: JSON.stringify(renderPayload),
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (!res.ok) throw new Error(`Render server returned ${res.status}`);
      console.log(`[SUCCESS] Posted Job ${jobId} to Discord via Render!`);
    } catch (err) {
      console.log(`Error posting to Render for ${jobId}:`, err);
    }
    
    // Pause for 3 seconds between scraping profiles
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('Finished processing. Closing browser.');
  await browser.close();
})();