
// ==UserScript==
// @name         RRR DONE
// @namespace    http://tampermonkey.net/
// @version      2.5.3
// @author       Ram Sai
// @description  10x parallel pages (fast!). Headings. Smart copy: ALL FC-Manual→RED, Non-FC→GREEN. First 5 cols. Smart units picker. RTCT full row.
// @match        https://optimus-internal.amazon.com/wims/v2/tasks*
// @match        https://optimus-internal-eu.amazon.com/wims/v2/tasks*
// @connect      rodeo-dub.amazon.com
// @connect      rodeo.amazon.com
// @connect      trans-logistics-eu.amazon.com
// @connect      trans-logistics.amazon.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const CFG = {
        RODEO_HOST: 'https://rodeo-dub.amazon.com',
        RTCT_HOST:  'https://trans-logistics-eu.amazon.com',
        WH_PATTERN: /^[A-Z]{2,4}\d{1,2}$/i,
        PARALLEL_BATCH: 10,       // v2.5.3: 10 pages at once (was 5)
        PAGE_DELAY_MS: 100,       // v2.5.3: 100ms delay (was 200)
        WIMS_CHAR_LIMIT: 1200,
        TYPES_MAX_COLS: 5,
        WORK_POOLS: [
            'PredictedCharge','PlannedShipment',
            'ReadyToPick','ReadyToPickHardCapped','ReadyToPickUnconstrained',
            'PickingNotYetPicked','PickingNotYetPickedPrioritized',
            'PickingNotYetPickedNotPrioritized','PickingNotYetPickedHardCapped',
            'CrossdockNotYetPicked',
            'PickingPicked','PickingPickedInProgress','PickingPickedInTransit',
            'PickingPickedRouting','PickingPickedAtDestination',
            'Inducted','RebinBuffered','Sorted','GiftWrap','Packing',
            'Scanned','ProblemSolving','ProcessPartial','SoftwareException',
            'Crossdock','PreSort','TransshipSorted','Palletized',
            'ManifestPending','ManifestPendingVerification','Manifested',
            'Loaded','TransshipManifested'
        ],
        WORK_POOL_SECTION_BREAKS: [1, 9, 27]
    };

    const LS = { origin:'roc_origin', dest:'roc_dest', date:'roc_date', pos:'roc_panel_pos' };

    function save(k,v){try{if(typeof GM_setValue==='function'){GM_setValue(k,v);return;}}catch(e){}try{localStorage.setItem(k,v);}catch(e){}}
    function load(k,d){try{if(typeof GM_getValue==='function'){const v=GM_getValue(k,undefined);if(v!==undefined)return v;}}catch(e){}try{const v=localStorage.getItem(k);return v===null?d:v;}catch(e){return d;}}

    async function copyText(text){
        try{if(typeof GM_setClipboard==='function'){GM_setClipboard(text,{type:'text',mimetype:'text/plain'});return true;}}catch(e){}
        try{await navigator.clipboard.writeText(text);return true;}catch(e){}
        const ta=document.createElement('textarea');ta.value=text;ta.style.cssText='position:fixed;opacity:0';
        document.body.appendChild(ta);ta.select();let ok=false;try{ok=document.execCommand('copy');}catch(e){}document.body.removeChild(ta);return ok;
    }

    const DEBUG=true,DBG=[];
    function dbg(l){DBG.push(l);console.log('[ROC]',l);}

    function fetchDoc(url){
        return new Promise((resolve,reject)=>{
            dbg('GET '+url);
            GM_xmlhttpRequest({
                method:'GET',url,
                headers:{'Accept':'text/html,application/xhtml+xml'},
                onload:(res)=>{
                    dbg('status='+res.status+' bytes='+(res.responseText||'').length);
                    const fu=(res.finalUrl||'').toLowerCase();
                    if(/midway|signin|sso|login|authportal|federate/.test(fu)){reject(new Error('Auth needed — open Rodeo, log in, retry.'));return;}
                    if(res.status>=200&&res.status<400){
                        try{const doc=new DOMParser().parseFromString(res.responseText,'text/html');resolve({doc,raw:res.responseText});}
                        catch(e){reject(new Error('Parse: '+e.message));}
                    }else reject(new Error('HTTP '+res.status));
                },
                onerror:()=>reject(new Error('Network error — VPN?')),
                ontimeout:()=>reject(new Error('Timeout 30s')),
                timeout:30000
            });
        });
    }

    function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

    const todayISO=()=>{const d=new Date(),p=n=>String(n).padStart(2,'0');return`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;};
    const clean=s=>(s||'').replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g,' ').replace(/\s+/g,' ').trim();
    function isValidWH(c){return CFG.WH_PATTERN.test((c||'').trim());}
    function isValidDate(d){return/^\d{4}-\d{2}-\d{2}$/.test(d)&&!isNaN(new Date(d+'T00:00:00').getTime());}
    function monthEndISO(dateISO){if(!isValidDate(dateISO))return dateISO;const[y,m]=dateISO.split('-').map(Number);const last=new Date(y,m,0).getDate();const pad=n=>String(n).padStart(2,'0');return`${y}-${pad(m)}-${pad(last)}`;}
    function commaNum(n){return String(n).replace(/\B(?=(\d{3})+(?!\d))/g,',');}
    function isFcManual(text){if(!text)return false;return/fc[\s_-]*manual/i.test(text);}

    function truncateToLimit(text,limit){
        if(!text)return'';if(text.length<=limit)return text;
        const lines=text.split('\n');let result='';const suffix='\n...truncated';const budget=limit-suffix.length;
        if(budget<=0)return text.substring(0,limit);
        for(const line of lines){const next=result?result+'\n'+line:line;if(next.length>budget)break;result=next;}
        if(!result)return lines[0].substring(0,budget)+suffix;
        return result+suffix;
    }

    function trimCols(row,maxCols){if(!row)return[];return row.slice(0,maxCols);}

    /* ═══ 1) RODEO UNITS ═══ */
    function buildExSDUrl(origin){
        const p=[];const add=(k,v)=>p.push(encodeURIComponent(k)+'='+encodeURIComponent(v));
        add('yAxis','WORK_POOL');add('zAxis','DESTINATION_WAREHOUSE_ID');
        add('shipmentTypes','TRANSSHIPMENTS');add('exSDRange.quickRange','PLUS_MINUS_3_DAYS');
        add('exSDRange.dailyStart','00:00');add('exSDRange.dailyEnd','00:00');
        add('giftOption','ALL');add('fulfillmentServiceClass','ALL');add('fracs','ALL');
        add('isEulerExSDMiss','ALL');add('isEulerPromiseMiss','ALL');add('isEulerUpgraded','ALL');add('isReactiveTransfer','ALL');
        CFG.WORK_POOLS.forEach((wp,i)=>{add('workPool',wp);if(CFG.WORK_POOL_SECTION_BREAKS.includes(i))add('_workPool','on');});
        add('_workPool','on');add('processPath','');add('minPickPriority','MIN_PRIORITY');
        add('shipMethod','');add('shipOption','');add('sortCode','');add('fnSku','');
        return`${CFG.RODEO_HOST}/${encodeURIComponent(origin)}/ExSD?${p.join('&')}`;
    }

    function extractHeaderCells(tr){const cells=[];if(!tr)return cells;tr.querySelectorAll('th').forEach(th=>{const clone=th.cloneNode(true);clone.querySelectorAll('br').forEach(br=>br.replaceWith(document.createTextNode(' ')));cells.push(clean(clone.textContent));});return cells;}
    function extractDataCells(tr){const cells=[];if(!tr)return cells;const label=tr.querySelector('th.row-label');if(label)cells.push(clean(label.textContent));else{const f=tr.querySelector('th,td');cells.push(f?clean(f.textContent):'');}tr.querySelectorAll('td').forEach(td=>cells.push(clean(td.textContent)));return cells;}

    function extractUnitsFromExSD(doc,dest){
        if(!doc)return{headers:[],rows:[],found:false};const destUC=dest.toUpperCase();
        let table=doc.getElementById(destUC+'Table')||doc.getElementById(dest+'Table')||doc.getElementById(dest.toLowerCase()+'Table');
        if(!table){for(const span of doc.querySelectorAll('span.process-path-title')){if(clean(span.textContent).toUpperCase()===destUC){let el=span;for(let i=0;i<10&&el;i++){el=el.nextElementSibling||(el.parentElement&&el.parentElement.nextElementSibling);if(!el)break;if(el.tagName==='TABLE'){table=el;break;}const t=el.querySelector&&el.querySelector('table.result-table');if(t){table=t;break;}}break;}}}
        if(!table){for(const t of doc.querySelectorAll('table.result-table')){if((t.id||'').toUpperCase().includes(destUC)){table=t;break;}}}
        if(!table){dbg('No table for '+destUC);return{headers:[],rows:[],found:false};}
        dbg('Found table id="'+(table.id||'')+'"');
        const headerTr=table.querySelector('tr.header-row');let headers=headerTr?extractHeaderCells(headerTr):[];
        const dataRows=[];
        table.querySelectorAll('tr').forEach(tr=>{
            if(tr.classList.contains('header-row'))return;
            const partTh=tr.querySelector('th.partition-name');const tds=tr.querySelectorAll('td');
            if(partTh&&tds.length===0){const l=clean(partTh.textContent);if(l&&headers.length){const row=[l];for(let i=1;i<headers.length;i++)row.push('');dataRows.push(row);}return;}
            const cells=extractDataCells(tr);if(cells.length>1&&cells.some(c=>c.length))dataRows.push(cells);
        });
        if(headers.length||dataRows.length){const mx=Math.max(headers.length,...dataRows.map(r=>r.length));while(headers.length<mx)headers.push('');dataRows.forEach(r=>{while(r.length<mx)r.push('');});}
        return{headers,rows:dataRows,found:true};
    }

    function formatExactCopy(dest,headers,dataRows){
        if(!headers||!headers.length||!dataRows||!dataRows.length)return'Rodeo Units\n'+dest+'\n(no data)';
        const filtered=dataRows.filter(r=>{
            if(!r||!r.length)return false;const label=(r[0]||'').trim().toLowerCase();
            if(label==='total')return true;
            return!r.slice(1).every(c=>{const v=(c||'').trim();return v==='0'||v==='';});
        });
        if(!filtered.length)return'Rodeo Units\n'+dest+'\n(no data)';
        const lines=[];
        lines.push('Rodeo Units');
        lines.push(dest);
        lines.push(headers.map(h=>(h||'').trim()).join('\t'));
        for(const r of filtered){lines.push(r.map(c=>(c||'').trim()).join('\t'));}
        return lines.join('\n');
    }

    function smartUnitsPicker(headers,dataRows,dateISO){
        const result={units:0,label:'Tot',source:'total'};
        if(!headers||!dataRows)return result;
        const totalRow=dataRows.find(r=>r&&(r[0]||'').trim().toLowerCase()==='total');
        if(!totalRow)return result;
        const selectedDay=dateISO?parseInt(dateISO.split('-')[2]):new Date().getDate();
        const selectedMonth=dateISO?parseInt(dateISO.split('-')[1]):(new Date().getMonth()+1);
        const dateCols=[];
        for(let i=1;i<headers.length;i++){
            const h=(headers[i]||'').trim();if(!h)continue;
            if(h==='Total'||h==='Earlier Total'||h==='Range Total'||h==='Later Total')continue;
            const dateMatch=h.match(/([A-Za-z]+)\s+(\d{1,2})\s+\d{2}:\d{2}/);
            if(dateMatch){
                const monthNames={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
                const mon=monthNames[(dateMatch[1]||'').toLowerCase().substring(0,3)]||0;
                const day=parseInt(dateMatch[2]);
                const val=parseInt((totalRow[i]||'0').replace(/,/g,''))||0;
                const shortLabel=h.replace(/\s+\d{2}:\d{2}$/,'');
                dateCols.push({colIdx:i,day,month:mon,label:shortLabel,value:val});
            }
        }
        const totalColIdx=headers.findIndex(h=>(h||'').trim()==='Total');
        const totalVal=totalColIdx>=0?(parseInt((totalRow[totalColIdx]||'0').replace(/,/g,''))||0):0;
        result.units=totalVal;result.label='Tot';result.source='total';
        const todayCols=dateCols.filter(c=>c.day===selectedDay&&c.month===selectedMonth);
        if(todayCols.length>0){const todaySum=todayCols.reduce((s,c)=>s+c.value,0);if(todaySum>0){result.units=todaySum;result.label=todayCols[0].label;result.source='today';return result;}}
        const futureCols=dateCols.filter(c=>(c.month>selectedMonth)||(c.month===selectedMonth&&c.day>selectedDay)).sort((a,b)=>(a.month-b.month)||(a.day-b.day));
        const futureDays=new Map();
        for(const c of futureCols){const key=c.month+'-'+c.day;if(!futureDays.has(key))futureDays.set(key,{label:c.label,sum:0});futureDays.get(key).sum+=c.value;}
        for(const[,info]of futureDays){if(info.sum>0){result.units=info.sum;result.label=info.label;result.source='future';return result;}}
        return result;
    }

    async function copyRodeoUnits(origin,dest,dateISO,onProgress){
        onProgress&&onProgress('Fetching ExSD...');
        const url=buildExSDUrl(origin)+'&_='+Date.now();
        const{doc}=await fetchDoc(url);
        const{headers,rows,found}=extractUnitsFromExSD(doc,dest);
        if(!found||!rows.length)throw new Error('No table for '+dest);
        const noteText=formatExactCopy(dest,headers,rows);
        const final=truncateToLimit(noteText,CFG.WIMS_CHAR_LIMIT);
        await copyText(final);
        const picked=smartUnitsPicker(headers,rows,dateISO);
        return{type:'units',picked,charLen:final.length};
    }

    /* ═══ 2) RODEO TYPES — 10x PARALLEL ═══ */
    function buildItemListUrl(origin,dest){
        const params=new URLSearchParams();params.set('shipmentType','TRANSSHIPMENTS');
        if(dest)params.set('DestinationWarehouseId',dest);
        return`${CFG.RODEO_HOST}/${encodeURIComponent(origin)}/ItemList?${params.toString()}`;
    }

    function getTableGrid(table){const rows=[];if(!table)return rows;table.querySelectorAll('tr').forEach(tr=>{const cells=[];tr.querySelectorAll('th,td').forEach(cell=>{const colspan=parseInt(cell.getAttribute('colspan'))||1;cells.push(clean(cell.textContent));for(let c=1;c<colspan;c++)cells.push('');});if(cells.some(c=>c.length))rows.push(cells);});return rows;}

    function findResultsTable(doc){
        if(!doc)return null;const tables=doc.querySelectorAll('table');let best=null,bestScore=0;
        for(const t of tables){const head=clean(t.textContent).toLowerCase();let score=0;
            if(head.includes('transfer request'))score+=3;if(head.includes('process path'))score+=2;
            if(head.includes('fn sku')||head.includes('fnsku'))score+=1;if(head.includes('need to ship'))score+=1;
            if(head.includes('destination warehouse'))score+=1;if(t.closest('nav,header,footer'))score-=5;
            score+=Math.min(t.querySelectorAll('tr').length,10)*0.1;
            if(score>bestScore){bestScore=score;best=t;}}
        return best;
    }

    function deriveRodeoPageUrl(knownUrl,targetPage){
        if(/pager\.TRANSSHIPMENTS\.currentPage=\d+/i.test(knownUrl))
            return knownUrl.replace(/pager\.TRANSSHIPMENTS\.currentPage=\d+/i,'pager.TRANSSHIPMENTS.currentPage='+targetPage);
        const sep=knownUrl.includes('?')?'&':'?';
        return knownUrl+sep+'pager.TRANSSHIPMENTS.currentPage='+targetPage+'&pager.TRANSSHIPMENTS.pageSize=1000';
    }

    function buildRodeoPageUrl(baseUrl,pageNum){
        const url=new URL(baseUrl);
        url.searchParams.set('pager.TRANSSHIPMENTS.currentPage',String(pageNum));
        url.searchParams.set('pager.TRANSSHIPMENTS.pageSize','1000');
        return url.href;
    }

    function detectPagination(doc,raw,baseUrl){
        const result={total:0,totalPages:1,nextUrls:[]};if(!doc)return result;
        const bodyText=(doc.body?doc.body.textContent:'')||'';
        const allLinks=doc.querySelectorAll('a[href]');
        const pageLinks=new Map();let maxPageNum=1;let nextHref=null;let discoveredPattern=null;
        for(const a of allLinks){
            const text=(a.textContent||'').trim();const href=(a.getAttribute('href')||'').trim();
            if(!href||href==='#')continue;
            if(/next/i.test(text)&&!/previous/i.test(text)){try{nextHref=href.startsWith('http')?href:new URL(href,baseUrl).href;}catch(e){}}
            if(/^\d+$/.test(text)){const num=parseInt(text);if(num>=1&&num<=500){maxPageNum=Math.max(maxPageNum,num);try{const fullUrl=href.startsWith('http')?href:new URL(href,baseUrl).href;pageLinks.set(num,fullUrl);if(num>=2&&!discoveredPattern)discoveredPattern=fullUrl;}catch(e){}}}
        }
        const nearPage=bodyText.match(/Page[:\s]*([\s\S]{0,200})/i);
        if(nearPage){const nums=nearPage[1].match(/\d+/g);if(nums)for(const n of nums){const pn=parseInt(n);if(pn>=1&&pn<=500)maxPageNum=Math.max(maxPageNum,pn);}}
        const showMatch=(raw||bodyText).match(/(?:showing|displaying|results?)\s+(\d[\d,]*)\s*[-\u2013]\s*(\d[\d,]*)\s+of\s+(\d[\d,]*)/i);
        if(showMatch){const start=parseInt(showMatch[1].replace(/,/g,''));const end=parseInt(showMatch[2].replace(/,/g,''));result.total=parseInt(showMatch[3].replace(/,/g,''));const perPage=end-start+1;if(perPage>0)maxPageNum=Math.max(maxPageNum,Math.ceil(result.total/perPage));}
        result.totalPages=maxPageNum;if(result.totalPages<=1)return result;
        dbg('Pagination: maxPage='+maxPageNum+' links='+pageLinks.size);
        for(let p=2;p<=result.totalPages;p++){
            if(pageLinks.has(p))result.nextUrls.push(pageLinks.get(p));
            else if(discoveredPattern)result.nextUrls.push(deriveRodeoPageUrl(discoveredPattern,p));
            else if(nextHref&&p===2)result.nextUrls.push(nextHref);
            else result.nextUrls.push(buildRodeoPageUrl(baseUrl,p));
        }
        return result;
    }

    // v2.5.3: Lightweight page fetch — only parse what we need
    async function fetchOnePage(pageUrl,trCol){
        try{
            const{doc:pageDoc}=await fetchDoc(pageUrl+(pageUrl.includes('_=')?'':'&_='+Date.now()));
            const pageTable=findResultsTable(pageDoc);
            if(!pageTable)return{rows:[]};
            const pageGrid=getTableGrid(pageTable);
            const phIdx=pageGrid.findIndex(r=>r.some(c=>/transfer[\s_-]*request/i.test(c)));
            const startIdx=phIdx>=0?phIdx+1:0;
            const pageData=pageGrid.slice(startIdx).filter(r=>r.join('').trim().length);
            return{rows:pageData};
        }catch(e){dbg('Page fetch err: '+e.message);return{rows:[]};}
    }

    // v2.5.3: ALL pages fetched in parallel batches of 10
    async function fetchAllItemListPages(origin,dest,onProgress){
        const t0=Date.now();
        const baseUrl=buildItemListUrl(origin,dest);const url1=baseUrl+'&_='+Date.now();
        onProgress&&onProgress('Fetching page 1...');
        const{doc:doc1,raw:raw1}=await fetchDoc(url1);
        const table1=findResultsTable(doc1);if(!table1)throw new Error('Item List table not found.');
        const grid1=getTableGrid(table1);if(!grid1.length)throw new Error('No rows.');
        let headerIdx=grid1.findIndex(r=>r.some(c=>/transfer[\s_-]*request/i.test(c)));if(headerIdx<0)headerIdx=0;
        const headers=grid1[headerIdx];let allDataRows=grid1.slice(headerIdx+1).filter(r=>r.join('').trim().length);
        dbg('Page 1: '+allDataRows.length+' rows ('+(Date.now()-t0)+'ms)');
        const pag=detectPagination(doc1,raw1,baseUrl);
        if(pag.totalPages<=1||pag.nextUrls.length===0){
            dbg('Single page, total time: '+(Date.now()-t0)+'ms');
            return{headers,allDataRows,totalPages:1,total:allDataRows.length,timeMs:Date.now()-t0};
        }

        const trCol=headers.findIndex(h=>/transfer[\s_-]*request/i.test(h));

        // v2.5.3: Fire ALL remaining pages in batches of 10
        for(let batchStart=0;batchStart<pag.nextUrls.length;batchStart+=CFG.PARALLEL_BATCH){
            const batchEnd=Math.min(batchStart+CFG.PARALLEL_BATCH,pag.nextUrls.length);
            const batchUrls=pag.nextUrls.slice(batchStart,batchEnd);
            const pageNums=batchUrls.map((_,i)=>batchStart+i+2);
            onProgress&&onProgress(`\u26A1 Scanning ${pageNums[0]}-${pageNums[pageNums.length-1]}/${pag.totalPages}...`);

            const promises=batchUrls.map((url,i)=>fetchOnePage(url,trCol).then(res=>({pageNum:pageNums[i],res})));
            const results=await Promise.all(promises);

            results.sort((a,b)=>a.pageNum-b.pageNum);
            for(const{pageNum,res}of results){
                if(res.rows.length>0){
                    allDataRows=allDataRows.concat(res.rows);
                    dbg('Page '+pageNum+': +'+res.rows.length+' (total:'+allDataRows.length+')');
                }
            }

            if(batchEnd<pag.nextUrls.length)await sleep(CFG.PAGE_DELAY_MS);
        }
        const elapsed=Date.now()-t0;
        dbg('All pages done: '+allDataRows.length+' rows in '+elapsed+'ms');
        return{headers,allDataRows,totalPages:pag.totalPages,total:allDataRows.length,timeMs:elapsed};
    }

    async function copyRodeoTypes(origin,dest,dateISO,onProgress){
        const{headers,allDataRows,totalPages,timeMs}=await fetchAllItemListPages(origin,dest,onProgress);
        if(!allDataRows||!allDataRows.length)throw new Error('No data rows.');
        let trCol=headers.findIndex(h=>/transfer[\s_-]*request/i.test(h));
        if(trCol<0)trCol=headers.findIndex(h=>/^tr[\s_-]*id$/i.test(h));
        if(trCol<0)trCol=0;
        onProgress&&onProgress(`Checking ${allDataRows.length} rows...`);

        const fcManualRows=[],otherRows=[];let skipped=0;
        for(const row of allDataRows){
            if(!row)continue;if(row.length<=trCol){skipped++;continue;}
            const trId=(row[trCol]||'').trim();if(!trId){skipped++;continue;}
            if(isFcManual(trId))fcManualRows.push(row);
            else otherRows.push(row);
        }
        const scanned=fcManualRows.length+otherRows.length;
        dbg('FC-Manual:'+fcManualRows.length+' Non-FC:'+otherRows.length+' Skip:'+skipped);

        const maxC=CFG.TYPES_MAX_COLS;
        const trimmedHeaders=trimCols(headers,maxC);
        let rowsToCopy;let allFc;

        if(otherRows.length===0){
            rowsToCopy=fcManualRows;allFc=true;
            dbg('Smart copy: ALL FC Manual → copying FC rows');
        }else{
            rowsToCopy=otherRows;allFc=false;
            dbg('Smart copy: Non-FC found → copying Non-FC rows only');
        }

        const lines=[];
        lines.push('Rodeo Types');
        lines.push(trimmedHeaders.map(h=>(h||'').trim()).join('\t'));
        for(const row of rowsToCopy){
            const trimmed=trimCols(row,maxC);
            lines.push(trimmed.map(c=>(c||'').trim()).join('\t'));
        }

        const final=truncateToLimit(lines.join('\n'),CFG.WIMS_CHAR_LIMIT);
        await copyText(final);

        const typeCount={};
        if(otherRows.length>0){for(const row of otherRows){const t=(row[trCol]||'').trim();const m=t.match(/^([A-Za-z][\w]*?)[-_](?=[A-Z]{2,4}\d)/);const typ=m&&m[1]?m[1]:t.split('-')[0]||'Unknown';const shortTyp=typ.length>25?typ.substring(0,25):typ;typeCount[shortTyp]=(typeCount[shortTyp]||0)+1;}}

        return{type:'types',totalPages,scanned,fcCount:fcManualRows.length,otherCount:otherRows.length,copiedCount:rowsToCopy.length,typeBreakdown:otherRows.length>0?typeCount:null,allFc,timeMs};
    }

    /* ═══ 3) RTCT ═══ */
    function buildRtctUrl(origin,dest,dateISO){
        const endISO=monthEndISO(dateISO);
        const params=new URLSearchParams();
        params.set('origin',origin);params.set('destination',dest);
        params.set('startDate',dateISO);params.set('endDate',endISO);
        params.set('forPromise','false');
        return`${CFG.RTCT_HOST}/transship/truck-schedule-result?${params.toString()}`;
    }

    function extractRtct(doc,raw){
        if(!doc)return[];
        const tables=doc.querySelectorAll('table');
        let best=null,bestScore=0;
        for(const t of tables){
            const txt=clean(t.textContent).toLowerCase();let score=0;
            if(txt.includes('departure cpt'))score+=5;if(txt.includes('arrival cpt'))score+=3;
            if(txt.includes('cost per unit'))score+=3;if(txt.includes('departure date'))score+=2;
            if(txt.includes('arrival date'))score+=2;if(txt.includes('departure day'))score+=2;
            if(txt.includes('search cpt'))score-=10;if(txt.includes('departing from'))score-=10;
            if(txt.includes('arriving at'))score-=10;
            if(txt.includes('start date')&&txt.includes('end date'))score-=10;
            if(t.closest('form'))score-=5;
            const rowCount=t.querySelectorAll('tr').length;
            if(rowCount<2)score-=3;
            score+=Math.min(rowCount,10)*0.1;
            dbg('RTCT table score='+score+' rows='+rowCount+' id='+(t.id||'none'));
            if(score>bestScore){bestScore=score;best=t;}
        }
        if(best&&bestScore>0){dbg('RTCT: using table score='+bestScore);return getTableGrid(best);}

        dbg('RTCT: no good table, trying regex...');
        const allText=raw||'';
        const datePattern=/(\d{1,2}-[A-Z][a-z]{2}-\d{2})/g;
        const cptPattern=/(\d{2}:\d{2}\s*(?:CET|CEST|GMT|UTC|BST))/gi;
        const costPattern=/(\d+\.\d{2}\s*EUR)/gi;
        const dates=[...allText.matchAll(datePattern)].map(m=>m[1]);
        const cpts=[...allText.matchAll(cptPattern)].map(m=>m[1]);
        const costs=[...allText.matchAll(costPattern)].map(m=>m[1]);
        if(dates.length>=2&&cpts.length>=2){
            const dayNames=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
            const getDayName=(ds)=>{try{const p=ds.match(/(\d{1,2})-([A-Z][a-z]{2})-(\d{2})/);if(!p)return'';const mo={Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};const d=new Date(2000+parseInt(p[3]),mo[p[2]]||0,parseInt(p[1]));return dayNames[d.getDay()]||'';}catch(e){return'';}};
            const rows=[['Departure Date','Departure Day','Departure CPT','Arrival Date','Arrival Day','Arrival CPT','Cost Per Unit']];
            const cnt=Math.floor(dates.length/2);
            for(let i=0;i<cnt;i++){rows.push([dates[i*2]||'',getDayName(dates[i*2]||''),cpts[i*2]||'',dates[i*2+1]||'',getDayName(dates[i*2+1]||''),cpts[i*2+1]||'',costs[i]||'']);}
            return rows;
        }

        dbg('RTCT: trying element scan...');
        for(const t of tables){const grid=getTableGrid(t);if(grid.length>=2){const headerRow=grid.find(r=>r.some(c=>/departure/i.test(c)));if(headerRow){const hIdx=grid.indexOf(headerRow);return grid.slice(hIdx);}}}
        dbg('RTCT: no data found');return[];
    }

    function extractRtctSummary(rows){
        if(!rows||rows.length<2)return null;
        const headers=rows[0];const data=rows[1];
        const get=(pat)=>{const i=headers.findIndex(h=>pat.test(h));return i>=0?(data[i]||'').trim():'';};
        return{depDate:get(/departure\s*date/i),depDay:get(/departure\s*day/i),depCpt:get(/departure\s*cpt/i),
            arrDate:get(/arrival\s*date/i),arrCpt:get(/arrival\s*cpt/i),cost:get(/cost/i),totalSchedules:rows.length-1};
    }

    async function copyRtct(origin,dest,dateISO,onProgress){
        onProgress&&onProgress('Fetching RTCT...');
        const url=buildRtctUrl(origin,dest,dateISO)+'&_='+Date.now();
        const{doc,raw}=await fetchDoc(url);
        const rows=extractRtct(doc,raw);
        if(!rows.length)throw new Error('RTCT: no schedule data found. Check lane exists.');
        const maxCols=Math.max(...rows.map(r=>r.length));
        rows.forEach(r=>{while(r.length<maxCols)r.push('');});
        const headers=rows[0]||[];const data=rows.slice(1);

        const lines=[];
        lines.push('RTCT');
        lines.push(`${origin}->${dest}`);
        lines.push(headers.map(h=>(h||'').trim()).join('\t'));
        for(const r of data){lines.push(r.map(c=>(c||'').trim()).join('\t'));}

        const final=truncateToLimit(lines.join('\n'),CFG.WIMS_CHAR_LIMIT);
        await copyText(final);
        const summary=extractRtctSummary(rows);
        return{type:'rtct',summary,charLen:final.length};
    }

    /* ═══ PANEL UI ═══ */
    const css=`
    #roc-panel{position:fixed;top:120px;right:18px;z-index:2147483000;width:340px;
      font-family:"Segoe UI",Arial,sans-serif;background:#1f2937;color:#f3f4f6;
      border:1px solid #374151;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);font-size:13px;}
    #roc-panel .hd{display:flex;align-items:center;justify-content:space-between;padding:9px 11px;
      background:#111827;border-radius:10px 10px 0 0;cursor:move;user-select:none;}
    #roc-panel .hd b{font-size:13px;}
    #roc-panel .hd .acts button{background:transparent;color:#9ca3af;border:0;cursor:pointer;font-size:15px;padding:2px 6px;}
    #roc-panel .hd .acts button:hover{color:#f3f4f6;}
    #roc-panel .bd{padding:12px;}
    #roc-panel .bd.collapsed{display:none;}
    #roc-panel .row2{display:flex;gap:8px;}
    #roc-panel .fld{margin-bottom:10px;flex:1;}
    #roc-panel .fld label{display:block;font-size:11px;color:#93c5fd;margin-bottom:3px;font-weight:600;}
    #roc-panel .fld input{width:100%;box-sizing:border-box;padding:7px 8px;border:1px solid #4b5563;
      border-radius:6px;background:#0b1220;color:#f3f4f6;font-size:13px;}
    #roc-panel .fld input.invalid{border-color:#f87171;background:#1a0505;}
    #roc-panel .btns{display:flex;flex-direction:column;gap:8px;margin-top:4px;}
    #roc-panel .cbtn{display:flex;align-items:center;justify-content:space-between;padding:9px 11px;
      border:0;border-radius:7px;cursor:pointer;font-size:13px;font-weight:600;color:#fff;transition:opacity .15s;}
    #roc-panel .cbtn small{font-weight:400;font-size:11px;opacity:.85;}
    #roc-panel .cbtn:disabled{opacity:.6;cursor:wait;}
    #roc-panel .b-units{background:#2563eb;} #roc-panel .b-units:hover:not(:disabled){background:#1d4ed8;}
    #roc-panel .b-types{background:#7c3aed;} #roc-panel .b-types:hover:not(:disabled){background:#6d28d9;}
    #roc-panel .b-rtct{background:#0d9488;}  #roc-panel .b-rtct:hover:not(:disabled){background:#0f766e;}
    #roc-panel .status{margin-top:10px;font-size:11px;color:#34d399;min-height:14px;word-break:break-word;}
    #roc-panel .scan-progress{margin-top:6px;font-size:11px;color:#93c5fd;}
    #roc-panel .info-row{margin-top:6px;padding:5px 8px;border-radius:5px;font-size:12px;display:none;font-weight:600;}
    #roc-panel .info-units{background:#172554;border:1px solid #1e3a5f;color:#93c5fd;}
    #roc-panel .info-types-ok{background:#064e3b;border:1px solid #065f46;color:#6ee7b7;}
    #roc-panel .info-types-warn{background:#7f1d1d;border:1px solid #991b1b;color:#fca5a5;}
    #roc-panel .info-rtct{background:#134e4a;border:1px solid #115e59;color:#5eead4;}
    #roc-bubble{position:fixed;top:120px;right:18px;z-index:2147483000;background:#2563eb;color:#fff;
      border-radius:20px;padding:8px 14px;font-family:"Segoe UI",Arial,sans-serif;font-size:13px;
      font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);user-select:none;}
    `;
    document.head.appendChild(Object.assign(document.createElement('style'),{textContent:css}));

    const panel=document.createElement('div');panel.id='roc-panel';
    panel.innerHTML=`
      <div class="hd"><b>\u{1F4E6} ROC v2.5.3</b><div class="acts"><button class="min" title="Minimize">\u2013</button><button class="close" title="Close">\u00D7</button></div></div>
      <div class="bd">
        <div class="row2">
          <div class="fld"><label>ORIGIN</label><input class="in-origin" placeholder="MRS1" maxlength="6"></div>
          <div class="fld"><label>DESTINATION</label><input class="in-dest" placeholder="BCN4" maxlength="6"></div>
        </div>
        <div class="fld"><label>DATE</label><input class="in-date" type="date"></div>
        <div class="btns">
          <button class="cbtn b-units">\u{1F4CA} ロデオユニット <small>ExSD</small></button>
          <button class="cbtn b-types">\u{1F4CB} ロデオタイプ <small>ALL pages \u26A1</small></button>
          <button class="cbtn b-rtct">\u{1F69A} アールティーシーティー <small>CPT schedule</small></button>
        </div>
        <div class="scan-progress"></div>
        <div class="info-row info-units"></div>
        <div class="info-row info-types"></div>
        <div class="info-row info-rtct"></div>
        <div class="status"></div>
      </div>`;
    document.body.appendChild(panel);

    const $=s=>panel.querySelector(s);
    const inOrigin=$('.in-origin'),inDest=$('.in-dest'),inDate=$('.in-date');
    const statusEl=$('.status'),bodyEl=$('.bd'),scanEl=$('.scan-progress');
    const infoUnits=$('.info-units'),infoTypes=$('.info-types'),infoRtct=$('.info-rtct');

    inOrigin.value=load(LS.origin,'')||'';inDest.value=load(LS.dest,'')||'';inDate.value=load(LS.date,'')||todayISO();
    inOrigin.addEventListener('input',()=>{inOrigin.value=inOrigin.value.toUpperCase();});
    inDest.addEventListener('input',()=>{inDest.value=inDest.value.toUpperCase();});
    inOrigin.addEventListener('change',()=>{const v=inOrigin.value.trim();inOrigin.classList.toggle('invalid',v&&!isValidWH(v));save(LS.origin,v);});
    inDest.addEventListener('change',()=>{const v=inDest.value.trim();inDest.classList.toggle('invalid',v&&!isValidWH(v));save(LS.dest,v);});
    inDate.addEventListener('change',()=>save(LS.date,inDate.value));

    function status(msg,ok=true){statusEl.textContent=msg;statusEl.style.color=ok?'#34d399':'#f87171';}
    function progress(msg){scanEl.textContent=msg||'';}

    function showUnitsSummary(res){
        infoUnits.style.display='block';
        const p=res.picked;
        const icon=p.source==='today'?'\u{1F4C5}':p.source==='future'?'\u{1F4C6}':'\u{1F4CA}';
        infoUnits.textContent=`${icon} ${p.label}: ${commaNum(p.units)}`;
    }

    // v2.5.3: Shows time taken
    function showTypesSummary(res){
        infoTypes.style.display='block';
        const sec=res.timeMs?((res.timeMs/1000).toFixed(1)+'s'):'';
        if(res.allFc){
            infoTypes.className='info-row info-types-warn';
            infoTypes.textContent=`\u{1F4CB} ${res.totalPages}pgs \u{1F534} All FC Manual (${commaNum(res.copiedCount)}) ${sec}`;
        }else{
            infoTypes.className='info-row info-types-ok';
            let tb='';if(res.typeBreakdown)tb=' ['+Object.entries(res.typeBreakdown).map(([t,n])=>t+':'+n).join(' ')+']';
            infoTypes.textContent=`\u{1F4CB} ${res.totalPages}pgs \u2705 ${res.copiedCount} Non-FC${tb} ${sec}`;
        }
    }

    function showRtctSummary(res){
        const s=res.summary;if(!s)return;infoRtct.style.display='block';
        if(s.depDate){
            const depDay3=(s.depDay||'').substring(0,3);
            const cost=s.cost?(' '+s.cost):'';
            infoRtct.textContent=`\u{1F69A} ${s.depDate} ${depDay3} ${s.depCpt} \u2192 ${s.arrDate}${cost}`;
        }else{
            infoRtct.textContent=`\u{1F69A} ${s.totalSchedules} schedules`;
        }
    }

    function lane(){return{o:inOrigin.value.trim().toUpperCase(),d:inDest.value.trim().toUpperCase(),dt:inDate.value||todayISO()};}
    function validate(){
        const{o,d,dt}=lane();
        if(!o){status('Enter ORIGIN.',false);inOrigin.focus();return false;}
        if(!isValidWH(o)){status('Invalid ORIGIN.',false);inOrigin.focus();return false;}
        if(!d){status('Enter DEST.',false);inDest.focus();return false;}
        if(!isValidWH(d)){status('Invalid DEST.',false);inDest.focus();return false;}
        if(!isValidDate(dt)){status('Invalid DATE.',false);inDate.focus();return false;}
        return true;
    }

    let running=false;
    async function run(btn,label,fn){
        if(running)return;if(!validate())return;running=true;
        const allBtns=panel.querySelectorAll('.cbtn');allBtns.forEach(b=>b.disabled=true);
        scanEl.textContent='';status(`Fetching ${label}...`);DBG.length=0;
        const oldDbg=panel.querySelector('.dbgbox');if(oldDbg)oldDbg.remove();
        try{
            const res=await fn(lane().o,lane().d,lane().dt,msg=>progress(msg));
            progress('');
            if(res.type==='units'){showUnitsSummary(res);status('\u2714 Copied');}
            else if(res.type==='types'){showTypesSummary(res);status('\u2714 Copied');}
            else if(res.type==='rtct'){showRtctSummary(res);status('\u2714 Copied');}
        }catch(e){
            progress('');status(e.message||'Error',false);
            if(DEBUG){
                const trace=`--- DEBUG (${label}) ---\n${lane().o}->${lane().d} ${lane().dt}\n${e.message}\n\n${DBG.join('\n')}`;
                await copyText(trace);
                let box=panel.querySelector('.dbgbox');if(box)box.remove();
                box=document.createElement('textarea');box.className='dbgbox';
                box.style.cssText='width:100%;box-sizing:border-box;margin-top:8px;height:100px;background:#0b1220;color:#fca5a5;border:1px solid #334155;border-radius:6px;font:11px/1.4 monospace;padding:6px;resize:vertical;';
                bodyEl.appendChild(box);box.value=trace;
            }
        }finally{allBtns.forEach(b=>b.disabled=false);running=false;}
    }

    $('.b-units').addEventListener('click',e=>run(e.currentTarget,'Rodeo Units',copyRodeoUnits));
    $('.b-types').addEventListener('click',e=>run(e.currentTarget,'Rodeo Types',copyRodeoTypes));
    $('.b-rtct').addEventListener('click',e=>run(e.currentTarget,'RTCT',copyRtct));

    $('.min').addEventListener('click',()=>{const c=bodyEl.classList.toggle('collapsed');$('.min').textContent=c?'+':'\u2013';});
    $('.close').addEventListener('click',()=>{panel.style.display='none';showBubble();});
    function showBubble(){if(document.getElementById('roc-bubble'))return;const b=document.createElement('div');b.id='roc-bubble';b.textContent='\u{1F4E6} ROC';b.addEventListener('click',()=>{panel.style.display='';b.remove();});document.body.appendChild(b);}

    (function restorePos(){try{const p=JSON.parse(load(LS.pos,'')||'null');if(p&&typeof p.top==='number'){panel.style.top=Math.max(0,Math.min(p.top,window.innerHeight-100))+'px';panel.style.left=Math.max(0,Math.min(p.left,window.innerWidth-100))+'px';panel.style.right='auto';}}catch(e){}})();
    (function drag(){const head=$('.hd');let d=false,ox=0,oy=0;head.addEventListener('mousedown',e=>{if(e.target.closest('button'))return;d=true;const r=panel.getBoundingClientRect();ox=e.clientX-r.left;oy=e.clientY-r.top;e.preventDefault();});document.addEventListener('mousemove',e=>{if(!d)return;panel.style.top=Math.max(0,Math.min(e.clientY-oy,window.innerHeight-50))+'px';panel.style.left=Math.max(0,Math.min(e.clientX-ox,window.innerWidth-50))+'px';panel.style.right='auto';});document.addEventListener('mouseup',()=>{if(!d)return;d=false;const r=panel.getBoundingClientRect();save(LS.pos,JSON.stringify({top:r.top,left:r.left}));});})();
})();

