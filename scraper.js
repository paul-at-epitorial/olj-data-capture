const { connect } = require("puppeteer-real-browser");
const { createCursor } = require("ghost-cursor");

const GOOGLE_SHEET_WEB_APP = 'https://script.google.com/macros/s/AKfycbz4XegBGQS31wmMsG8Ux-jPnfdSHHiZCAH250d_E0ZOKwjBk5BiQn1x-RoE4Dk8RHvI/exec';
const DISCORD_WEBHOOK = 'https://va-job-bot.onrender.com/new-job';

(async () => {
  console.log('Launching real browser proxy in cloud mode...');
  
  fetch('https://va-job-bot.onrender.com').catch(() => {});

  const { browser, page } = await connect({
      headless: "auto",
      turnstile: true, 
  });
  
  await page.setViewport({ width: 1920, height: 1080 });

  console.log('Loading OnlineJobs.ph...');
  await page.goto('https://www.onlinejobs.ph/jobseekers/jobsearch', { waitUntil: 'networkidle2' });
  
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

  const uniqueListings = [...new Map(jobListings.map(item => [item.url, item])).values()];
  console.log(`Found ${uniqueListings.length} jobs. Processing...`);

  for (let listing of uniqueListings) {
    const link = listing.url;
    let rawTime = listing.postedTime; 
    
    const jobId = link.split('/').pop().split('-').pop(); 

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

    console.log(`[NEW] Extracting data for Job ${jobId}...`);
    
    let jobData;
    try {
      await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });

      const cursor = createCursor(page);
      await cursor.randomMove();
      await page.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 500) + 200));
      await new Promise(r => setTimeout(r, Math.random() * 2000 + 1500)); 

      jobData = await page.evaluate(() => {
        const cleanText = (text) => text ? text.replace(/\?{2,}/g, '').trim() : 'N/A';
        const getText = (selector) => cleanText(document.querySelector(selector) ? document.querySelector(selector).innerText : 'N/A');
        const getSiblingText = (labelText) => {
          const headers = Array.from(document.querySelectorAll('h3, dt, strong, span, p')); 
          const target = headers.find(h => h.innerText.trim().toUpperCase().includes(labelText.toUpperCase()));
          return cleanText(target && target.nextElementSibling ? target.nextElementSibling.innerText : 'N/A');
        };
        
        let rawDesc = getText('#job-description').replace(/\n{3,}/g, '\n\n');
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
    } catch (error) {
      console.log(`[ERROR] Could not load or read Job ${jobId}. It may be deleted or blocked. Skipping...`);
      continue; 
    }

    let displayHours = jobData.hours;
    if (/\d/.test(displayHours) && !/hour|hrs/i.test(displayHours)) {
        displayHours += " hours";
    }

    const statusCheck = (jobData.title + " " + jobData.description).toLowerCase();
    if (statusCheck.includes("has been closed") || statusCheck.includes("no longer posted") || statusCheck.includes("has been deleted") || statusCheck.includes("no longer visible") || statusCheck.includes("no longer available")) {
        console.log(`[SKIPPED] Job ${jobId} is closed or deleted.`);
        continue;
    }

    try {
        const saveRes = await fetch(GOOGLE_SHEET_WEB_APP, {
            method: 'POST',
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

    const searchText = (jobData.title + " " + jobData.description).toLowerCase();
    
    const kwSystems = ['gohighlevel', 'ghl', 'zapier', 'make.com', 'api', 'automation', 'webhook', 'crm', 'activecampaign', 'hubspot', 'systems'];
    const kwMarketing = ['marketing', 'seo', 'social media', 'campaign', 'media buyer', 'facebook ads', 'google ads', 'lead gen', 'outreach', 'cold call', 'email', 'tiktok', 'instagram'];
    const kwEcom = ['amazon', 'fba', 'dropship', 'shopify', 'ecommerce', 'e-commerce', 'product research', 'sourcing', 'seller central', 'walmart', 'arbitrage'];
    const kwCreative = ['video', 'editor', 'design', 'graphic', 'thumbnail', 'premiere', 'after effects', 'photoshop', 'illustrator', 'canva', 'copywrit', 'ui/ux', 'blog', 'midjourney', 'runway'];
    const kwTech = ['tech', 'developer', 'code', 'it support', 'web', 'software', 'programmer', 'python', 'javascript'];
    const kwManagement = ['manage', 'director', 'lead', 'supervisor', 'head of'];
    
    let category = "admin-va"; 

    if (kwCreative.some(kw => searchText.includes(kw))) category = "creative-va";
    else if (kwEcom.some(kw => searchText.includes(kw))) category = "ecom-va";
    else if (kwMarketing.some(kw => searchText.includes(kw))) category = "marketing-va";
    else if (kwSystems.some(kw => searchText.includes(kw))) category = "automations-va";
    else if (kwTech.some(kw => searchText.includes(kw))) category = "tech-va";
    else if (kwManagement.some(kw => searchText.includes(kw))) category = "management-va";

    // Typo fixed here on the title string: **${jobData.title}**
    const richTitle = `**${jobData.title}**\n\n💰 **Salary:** ${jobData.salary}\n🕒 **Type:** ${jobData.type} | ${displayHours}\n📝 **Description:**\n${jobData.description}`;

    const renderPayload = {
      jobCategoryKey: category,
      jobTitle: richTitle,
      jobLink: `<${link}>`
    };

    try {
      const res = await fetch(DISCORD_WEBHOOK, {
        method: 'POST',
        body: JSON.stringify(renderPayload),
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': 'SECRET_KEY_12345' 
        }
      });
      
      if (!res.ok) throw new Error(`Render server returned ${res.status}`);
      console.log(`[SUCCESS] Posted Job ${jobId} to Discord via Render!`);
    } catch (err) {
      console.log(`Error posting to Render for ${jobId}:`, err);
    }
    
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('Finished processing. Closing browser.');
  await browser.close();
})();