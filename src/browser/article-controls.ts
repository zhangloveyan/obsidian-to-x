/** Serialized into the X page; keep all browser logic inside this function. */
export function createArticleDraft(): { previous: string[] } {
  if (location.hostname !== 'x.com' || location.pathname !== '/compose/articles') {
    throw new Error('MXP_PAGE_CHANGED: 页面已离开 X 文章列表，未创建草稿。');
  }
  const candidates = [...document.querySelectorAll<HTMLButtonElement>('main button[aria-label="create"]')].filter(button => {
    if (button.type !== 'button' || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
    if (button.closest('a[href*="/articles/edit/"]')) return false;
    const bounds = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
  });
  if (candidates.length > 1) {
    throw new Error(`MXP_CREATE_AMBIGUOUS: 找到 ${candidates.length} 个新建文章入口，无法确定安全的创建按钮。`);
  }
  if (!candidates.length) throw new Error('未找到新建文章入口，请等待 X 文章列表加载完成。');
  const previous = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].flatMap(link => {
    const id = link.getAttribute('href')?.match(/\/articles\/edit\/(\d+)(?:[/?#]|$)/)?.[1];
    return id ? [id] : [];
  });
  candidates[0]!.click();
  return { previous };
}
