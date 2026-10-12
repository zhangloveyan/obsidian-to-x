import { Modal, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import Cropper from 'cropperjs';
import { loadImage } from '../assets';
import type { CoverCropData, CoverSelection } from './cover-selection';
import { encodeCroppedCover, prepareCoverImage } from './cover-crop-image';

/** The picker stays underneath so Back also preserves its current selection. */
export class CoverCropModal extends Modal {
  private alive = false;
  private cropper?: Cropper;
  private objectUrl?: string;
  private resizeObserver?: ResizeObserver;
  private resizeFrame?: number;

  constructor(app: App, private coverSelection: CoverSelection, private notePath: string,
    private apply: (selection: CoverSelection) => void, private dismissed?: () => void) { super(app); }

  onOpen(): void {
    this.alive = true;
    this.setTitle('编辑媒体');
    this.modalEl.addClass('mxp-crop-modal');
    const root = this.contentEl;
    root.empty();
    const header = root.createDiv({ cls: 'mxp-crop-header' });
    const back = header.createEl('button', { cls: 'mxp-icon-button', attr: { type: 'button', 'aria-label': '返回' } });
    setIcon(back, 'arrow-left');
    header.createEl('span', { cls: 'mxp-crop-title', text: '编辑媒体' });
    const apply = header.createEl('button', { text: '应用', cls: 'mod-cta', attr: { type: 'button' } });
    apply.disabled = true;
    const stage = root.createDiv({ cls: 'mxp-crop-stage', attr: { tabindex: '0', role: 'group', 'aria-label': '封面裁剪区域，拖动图片或使用方向键调整位置' } });
    const controls = root.createDiv({ cls: 'mxp-crop-controls' });
    const smaller = controls.createEl('button', { cls: 'mxp-icon-button', attr: { type: 'button', 'aria-label': '缩小图片' } });
    setIcon(smaller, 'zoom-out');
    const slider = controls.createEl('input', { attr: { type: 'range', min: '1', max: '4', step: '0.01', value: '1', 'aria-label': '图片缩放' } });
    const larger = controls.createEl('button', { cls: 'mxp-icon-button', attr: { type: 'button', 'aria-label': '放大图片' } });
    setIcon(larger, 'zoom-in');
    for (const control of [smaller, slider, larger]) control.disabled = true;
    const status = root.createDiv({ cls: 'mxp-help mxp-crop-help', text: '正在读取图片…', attr: { role: 'status' } });
    back.addEventListener('click', () => this.close());
    void (async () => {
      try {
        const original = this.coverSelection.crop?.original ?? this.coverSelection.asset ?? await loadImage(this.app, this.coverSelection.source, this.notePath);
        if (!this.alive) return;
        const prepared = await prepareCoverImage(original);
        if (!this.alive) { URL.revokeObjectURL(prepared.url); return; }
        this.objectUrl = prepared.url;
        const image = stage.createEl('img', { attr: { alt: '待裁剪封面', src: prepared.url } });
        let ready = false;
        let exporting = false;
        const minimumRatio = (): number => {
          const box = this.cropper!.getCropBoxData();
          return Math.max(box.width / prepared.width, box.height / prepared.height);
        };
        const syncZoom = (): void => {
          if (!ready || !this.cropper) return;
          const ratio = this.cropper.getImageData().width / prepared.width;
          const value = Math.max(1, ratio / minimumRatio());
          slider.value = String(value);
          slider.setAttribute('aria-valuetext', `${Math.round(value * 100)}%`);
          smaller.disabled = exporting || value <= 1.001;
          larger.disabled = exporting || value >= 3.999;
        };
        const zoomTo = (value: number): void => {
          if (ready && !exporting && this.cropper) {
            this.cropper.zoomTo(minimumRatio() * Math.max(1, Math.min(4, value)));
            syncZoom();
          }
        };
        let measuredWidth = stage.clientWidth;
        let measuredHeight = stage.clientHeight;
        const mountCropper = (previous?: CoverCropData): void => {
          ready = false;
          this.cropper?.destroy();
          this.cropper = new Cropper(image, {
            aspectRatio: 5 / 2, viewMode: 1, dragMode: 'move', autoCropArea: 1,
            responsive: false,
            cropBoxMovable: false, cropBoxResizable: false, toggleDragModeOnDblclick: false,
            background: false, guides: false, center: false, highlight: false,
            rotatable: false, scalable: false, zoomOnWheel: false, zoomOnTouch: false,
            checkOrientation: false, checkCrossOrigin: false,
            ready: () => {
              if (!this.alive || !this.cropper) return;
              const bounds = this.cropper.getContainerData();
              const width = Math.min(bounds.width - 32, (bounds.height - 32) * 2.5);
              const height = width / 2.5;
              // Set the minimum filled canvas first: tall images must still get a wide frame.
              const scale = Math.max(width / prepared.width, height / prepared.height);
              this.cropper.setCanvasData({ width: prepared.width * scale, height: prepared.height * scale,
                left: (bounds.width - prepared.width * scale) / 2, top: (bounds.height - prepared.height * scale) / 2 });
              this.cropper.setCropBoxData({ width, height, left: (bounds.width - width) / 2, top: (bounds.height - height) / 2 });
              if (previous) {
                // setData resizes Cropper's crop box; restore the image underneath
                // the fixed frame instead, retaining the original zoom and offset.
                const data = previous;
                const restoredScale = width / data.width;
                this.cropper.setCanvasData({ width: prepared.width * restoredScale, height: prepared.height * restoredScale,
                  left: (bounds.width - width) / 2 - data.x * restoredScale,
                  top: (bounds.height - height) / 2 - data.y * restoredScale });
              }
              ready = true;
              slider.disabled = false;
              apply.disabled = false;
              syncZoom();
              status.setText('固定 5:2 · 拖动图片调整位置，滑动缩放');
            },
            crop: () => syncZoom(),
          });
        };
        mountCropper(this.coverSelection.crop?.data);
        this.resizeObserver = new ResizeObserver(() => {
          if (!this.alive || !ready || exporting || !this.cropper) return;
          if (measuredWidth === stage.clientWidth && measuredHeight === stage.clientHeight) return;
          window.cancelAnimationFrame(this.resizeFrame ?? 0);
          this.resizeFrame = window.requestAnimationFrame(() => {
            if (!this.alive || !ready || exporting || !this.cropper) return;
            const previous = this.cropper.getData();
            measuredWidth = stage.clientWidth;
            measuredHeight = stage.clientHeight;
            mountCropper(previous);
          });
        });
        this.resizeObserver.observe(stage);
        slider.addEventListener('input', () => zoomTo(Number(slider.value)));
        smaller.addEventListener('click', () => zoomTo(Number(slider.value) - 0.1));
        larger.addEventListener('click', () => zoomTo(Number(slider.value) + 0.1));
        stage.addEventListener('keydown', event => {
          const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
          if (!delta || !ready || exporting) return;
          event.preventDefault();
          const distance = event.shiftKey ? 20 : 5;
          this.cropper?.move(delta[0]! * distance, delta[1]! * distance);
        });
        apply.addEventListener('click', () => {
          if (!this.alive || !ready || exporting || !this.cropper) return;
          exporting = true;
          apply.disabled = true;
          slider.disabled = true;
          smaller.disabled = true;
          larger.disabled = true;
          this.cropper.disable();
          status.setText('正在生成封面…');
          void (async () => {
            try {
              const data = this.cropper!.getData();
              const width = Math.max(5, Math.floor(Math.min(2560, data.width) / 5) * 5);
              const canvas = this.cropper!.getCroppedCanvas({ width, height: width * 2 / 5, imageSmoothingEnabled: true, imageSmoothingQuality: 'high' });
              if (!canvas) throw new Error('无法生成封面，请重新选择图片。');
              const asset = await encodeCroppedCover(canvas, original);
              if (!this.alive) return;
              this.apply({ source: asset.source, asset, crop: { original, data: { x: data.x, y: data.y, width: data.width, height: data.height } } });
              this.close();
            } catch (error) {
              if (!this.alive) return;
              status.setText(error instanceof Error ? error.message : '裁剪失败，请重试。');
              exporting = false;
              this.cropper?.enable();
              apply.disabled = false;
              slider.disabled = false;
              syncZoom();
            }
          })();
        });
      } catch (error) {
        console.error('Markdown X Publisher: cover crop initialization failed', error);
        if (this.alive) status.setText(error instanceof Error ? error.message : '图片无法读取，请返回重新选择。');
      }
    })();
  }

  onClose(): void {
    this.alive = false;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    window.cancelAnimationFrame(this.resizeFrame ?? 0);
    this.resizeFrame = undefined;
    this.cropper?.destroy();
    this.cropper = undefined;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
    this.contentEl.empty();
    this.dismissed?.();
  }
}
