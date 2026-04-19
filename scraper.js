const puppeteer = require('puppeteer');

// Paste your actual URLs here
const GOOGLE_SHEET_WEB_APP = 'https://script.google.com/macros/s/AKfycbxXjl7h99EAeJmLG3tkhOWJKZ3J88oubMNHDFsWa1zlr1nFLZFBRtal2CSxePdGSx6J/exec';
const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1495231809527742635/0mFhDtm76pHDpaARu2EwNEOZVvId3LJibKyh0FLBASIIzG_UassdNXvK6BHGqQL9ZI-G';

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

    // 4. Ping Google Sheets to check for duplicates
    try {
      const checkRes = await fetch(GOOGLE_SHEET_WEB_APP, {
        method: 'POST',
        body: JSON.stringify({ jobId: jobId }),
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

    // Extract the text using DOM selectors (Employer data removed)
    const jobData = await page.evaluate(() => {
      
      const getText = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.innerText.trim() : 'N/A';
      };
      
      const getSiblingText = (labelText) => {
        const headers = Array.from(document.querySelectorAll('h3, dt, strong, span, p')); 
        const target = headers.find(h => h.innerText.trim().toUpperCase().includes(labelText.toUpperCase()));
        return target && target.nextElementSibling ? target.nextElementSibling.innerText.trim() : 'N/A';
      };
      
      return {
        title: getText('h1'), 
        salary: getSiblingText('WAGE / SALARY'),
        type: getSiblingText('TYPE OF WORK'),
        hours: getSiblingText('HOURS PER WEEK'),
        description: getText('#job-description').substring(0, 500) + '...'
      };
    });

    // 6. Format the Discord message
    const discordMessage = {
      content: `🚨 **NEW JOB ALERT** 🚨\n**Posted:** ${displayTime}\n\n**${jobData.title}**\n\n💰 **Salary:** ${jobData.salary}\n🕒 **Type:** ${jobData.type} | ${jobData.hours}\n📝 **Description:**\n${jobData.description}\n\n🔗 **Link:** ${link}`
    };

    // 7. Fire it to Discord
    try {
      await fetch(DISCORD_WEBHOOK, {
        method: 'POST',
        body: JSON.stringify(discordMessage),
        headers: { 'Content-Type': 'application/json' }
      });
      console.log(`[SUCCESS] Posted Job ${jobId} to Discord!`);
    } catch (err) {
      console.log(`Error posting to Discord for ${jobId}:`, err);
    }
    
    // Pause for 3 seconds between scraping profiles
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('Finished processing. Closing browser.');
  await browser.close();
})();