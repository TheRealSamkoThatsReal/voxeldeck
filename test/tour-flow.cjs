// End-to-end test of the INTERACTIVE guided tour against the real main.js.
// Drives it like a user (real clicks on the + and Create), asserting every step,
// ring target, modal-open/create advance, and the cancel-rewind watchdog.
// Run on a machine with a display:  electron test/tour-flow.cjs
// Or headless:  xvfb-run -a electron test/tour-flow.cjs
const { app, BrowserWindow } = require('electron');
const os = require('os'), fs = require('fs'), path = require('path');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-tf-'));
app.setPath('userData', ud);
// seed serversRoot so the real create lands in tmp
fs.writeFileSync(path.join(ud, 'servers.json'), JSON.stringify({
  version: 1, settings: { serversRoot: path.join(ud, 'srv'), tourSeen: true }, servers: []
}));
require('/home/sam/Documents/minecraftdash/src/main/main.js');

app.whenReady().then(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const win = BrowserWindow.getAllWindows()[0];
  const r = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ok = (n, c) => out.push((c ? 'PASS ' : 'FAIL ') + n);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const waitStep = async (id, ms=3000) => { const t=Date.now(); while(Date.now()-t<ms){ if(tour.steps[tour.index].id===id) return true; await sleep(60);} return false; };
    // ring is centered on element when their centers match (±6px)
    const ringOn = (sel) => {
      const e = document.querySelector(sel); if(!e) return false;
      const er = e.getBoundingClientRect(); const rr = document.getElementById('tourRing').getBoundingClientRect();
      return Math.abs((er.left+er.width/2)-(rr.left+rr.width/2))<8 && Math.abs((er.top+er.height/2)-(rr.top+rr.height/2))<8;
    };

    startTour();
    ok('1 welcome is centered (ring hidden)', tour.steps[tour.index].id==='welcome' && document.getElementById('tourRing').style.display==='none');
    tourNext();
    ok('2 click-plus ring on +', tour.steps[tour.index].id==='click-plus' && ringOn('#addServerBtn'));

    document.getElementById('addServerBtn').click();           // open modal
    ok('3 advanced to name on modal open', await waitStep('name'));
    await sleep(80);
    ok('4 name ring on name field', ringOn('#tourAddName'));
    ok('5 modal still open (interactive)', isModalOpen());

    tourNext();
    await sleep(120);
    ok('6 software ring on software dropdown', tour.steps[tour.index].id==='software' && ringOn('#tourAddType'));
    tourNext();
    await sleep(120);
    ok('7 version step ring on version dropdown', tour.steps[tour.index].id==='version' && ringOn('#tourAddVersion'));
    tourNext();
    ok('8 create step shown', tour.steps[tour.index].id==='create');

    // Use a non-auto type so create doesn't trigger a real ~50MB jar download in the test.
    document.getElementById('tourAddName').value='Tour Server';
    const tsel=document.getElementById('tourAddType'); tsel.value='forge'; tsel.dispatchEvent(new Event('change'));
    await sleep(150);
    document.getElementById('tourAddCreate').click();          // creates an empty folder (no download)
    ok('9 advanced to tabs after create', await waitStep('tabs', 6000));
    ok('10 a server now exists & detail open', state.view==='detail' && state.servers.length===1);
    await sleep(80);
    ok('11 tabs ring on tab strip', ringOn('#tabs'));

    tourNext();
    await sleep(80);
    ok('12 settings-tab ring', tour.steps[tour.index].id==='settings-tab' && ringOn('.tab[data-tab="settings"]'));
    tourNext();
    await sleep(80);
    ok('13 toggle ring on power switch', tour.steps[tour.index].id==='toggle' && ringOn('#powerSwitch'));
    tourNext();
    ok('14 finish centered', tour.steps[tour.index].id==='finish');
    tourNext(); // Done -> endTour
    ok('15 tour cleaned up (root removed)', !document.getElementById('tourRoot'));

    // watchdog: reopening tour, cancel modal mid-flow rewinds to click-plus
    startTour(); tourNext();
    document.getElementById('addServerBtn').click(); await waitStep('name'); tourNext(); // software
    document.querySelector('#modalHost').classList.add('hidden'); document.querySelector('#modalHost').innerHTML=''; // user cancels
    ok('16 watchdog rewinds to click-plus on modal cancel', await waitStep('click-plus', 2000));
    endTour();
    return out;
  })()`).catch(e => ['FAIL eval: ' + e.message]);
  r.forEach(l => console.log('  ' + l));
  const failed = r.filter(l => l.startsWith('FAIL')).length;
  console.log(failed ? ('\\n' + failed + ' FAILED') : '\\nALL ' + r.length + ' PASSED');
  fs.rmSync(ud, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
});
