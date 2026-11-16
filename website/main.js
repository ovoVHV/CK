import './lightbox.js';
import {refreshRelease} from './release.js';
if(document.querySelector('[data-release-version]'))void refreshRelease();
const menu=document.querySelector('#menu-toggle');
menu?.addEventListener('click',()=>{const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));document.querySelector('.nav-links').classList.toggle('open',open);});
document.querySelectorAll('.nav-links a').forEach(a=>a.addEventListener('click',()=>{menu?.setAttribute('aria-expanded','false');document.querySelector('.nav-links').classList.remove('open');}));
if(document.querySelector('#blockly-demo')) {
    import('./demo.js').then(m=>m.startDemo()).catch(()=>{
        document.querySelector('#demo-status').textContent='交互演示暂未加载成功。可刷新重试，或下载桌面版体验。';
    });
}
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{
    const pane=document.querySelector('.demo-body');
    pane.dataset.view=button.dataset.view;
    document.querySelectorAll('[data-view]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});
    window.dispatchEvent(new Event('resize'));
}));
