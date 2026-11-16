const links=[...document.querySelectorAll('[data-visual-title]')];
if(links.length){
 const dialog=document.createElement('dialog');dialog.className='visual-dialog';dialog.setAttribute('aria-labelledby','visual-dialog-title');
 const bar=document.createElement('div');bar.className='visual-dialog-bar';
 const title=document.createElement('h2');title.id='visual-dialog-title';
 const close=document.createElement('button');close.type='button';close.textContent='关闭 ×';close.setAttribute('aria-label','关闭图片预览');
 bar.append(title,close);
 const scroll=document.createElement('div');scroll.className='visual-dialog-scroll';
 const img=document.createElement('img');scroll.append(img);
 const caption=document.createElement('p');caption.className='visual-dialog-caption';
 dialog.append(bar,scroll,caption);document.body.append(dialog);
 let returnTo=null;
 for(const link of links)link.addEventListener('click',event=>{
  if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||event.button!==0)return;
  event.preventDefault();returnTo=link;title.textContent=link.dataset.visualTitle;
  img.src=link.href;img.alt=link.querySelector('img').alt;
  caption.textContent=link.closest('figure').querySelector('figcaption').textContent;
  dialog.showModal();document.body.classList.add('visual-is-open');close.focus();
 });
 close.addEventListener('click',()=>dialog.close());
 dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
 dialog.addEventListener('close',()=>{document.body.classList.remove('visual-is-open');returnTo?.focus({preventScroll:true});});
}
