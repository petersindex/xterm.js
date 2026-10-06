/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { IDisposable } from '@xterm/xterm';
import { ImageStorage } from '../ImageStorage';
import { ImageLayer, IAddImageOpts, IImageSpec, IPlaceholderImage, IPlaceholderImages } from '../Types';
import { IKittyImageData } from './KittyGraphicsTypes';

// Kitty-specific image storage controller.
//
// Wraps shared ImageStorage with kitty protocol semantics:
// - tracks transmitted image payloads by kitty image id
// - tracks kitty image id -> shared ImageStorage id mapping for displayed images
// - mirrors shared-storage evictions into kitty maps
// - applies protocol-level undisplayed-image eviction policy
export class KittyImageStorage implements IDisposable, IPlaceholderImages {
  private static readonly _maxStoredImages = 256;

  private _nextImageId = 1;
  private readonly _images: Map<number, IKittyImageData> = new Map();
  // TODO: Support multiple placements per image. The kitty spec identifies
  // placements by an (image id, placement id) pair — same i + different p
  // values should coexist, and same i + same p should replace the prior
  // placement. Currently we track only one storage entry per kitty image id,
  // so multiple placements of the same image overwrite each other. Fixing
  // this requires changing these maps to Map<number, Map<number, number>>
  // (kittyId → placementId → storageId) and updating addImage/deleteById
  // accordingly. The underlying shared ImageStorage would also need to
  // support multiple entries per logical image.
  private readonly _kittyIdToStorageId: Map<number, number> = new Map();
  private readonly _storageIdToKittyId: Map<number, number> = new Map();
  // Virtual placements (U=1), by kitty image id then placement id. They have
  // no position of their own: placeholder cells name them where they show.
  private readonly _virtual: Map<number, Map<number, IPlaceholderImage>> = new Map();

  private readonly _previousOnImageDeleted: ((storageId: number) => void) | undefined;
  private readonly _wrappedOnImageDeleted: (storageId: number) => void;
  private readonly _handleStorageImageDeleted = (storageId: number): void => {
    const kittyId = this._storageIdToKittyId.get(storageId);
    if (kittyId !== undefined) {
      this._kittyIdToStorageId.delete(kittyId);
      this._storageIdToKittyId.delete(storageId);
      this._images.delete(kittyId);
    }
  };
  private _addImageOpts: IAddImageOpts = { scrolling: true, layer: 'top', zIndex: 0, cursorPos: 'iip' };

  constructor(
    private readonly _storage: ImageStorage
  ) {
    this._previousOnImageDeleted = this._storage.onImageDeleted;
    this._wrappedOnImageDeleted = (storageId: number) => {
      this._previousOnImageDeleted?.(storageId);
      this._handleStorageImageDeleted(storageId);
    };
    this._storage.onImageDeleted = this._wrappedOnImageDeleted;
    this._storage.placeholderImages = this;
  }

  public reset(): void {
    this._nextImageId = 1;
    this._images.clear();
    this._virtual.clear();
    this._kittyIdToStorageId.clear();
    this._storageIdToKittyId.clear();
  }

  public dispose(): void {
    this.reset();
    if (this._storage.onImageDeleted === this._wrappedOnImageDeleted) {
      this._storage.onImageDeleted = this._previousOnImageDeleted;
    }
    if (this._storage.placeholderImages === this) {
      this._storage.placeholderImages = undefined;
    }
  }

  public storeImage(id: number | undefined, imageData: Omit<IKittyImageData, 'id'>): number {
    const imageId = id ?? this._nextImageId++;

    const oldStorageId = this._kittyIdToStorageId.get(imageId);
    if (oldStorageId !== undefined) {
      this._storage.deleteImage(oldStorageId);
      this._kittyIdToStorageId.delete(imageId);
      this._storageIdToKittyId.delete(oldStorageId);
    }

    if (!this._images.has(imageId) && this._images.size >= KittyImageStorage._maxStoredImages) {
      this._evictUndisplayedImages();
    }

    this._images.set(imageId, {
      ...imageData,
      id: imageId
    });
    return imageId;
  }

  public addImage(kittyId: number, image: HTMLCanvasElement | ImageBitmap, scrolling: boolean, layer: ImageLayer, zIndex: number): void {
    // Clean up stale reverse-mapping from a previous placement of the same
    // kitty image.  The old shared-storage entry is kept (it may still be
    // visible on screen) but its reverse mapping is removed so that eviction
    // of the old entry won't incorrectly delete the kitty image data.
    const oldStorageId = this._kittyIdToStorageId.get(kittyId);
    if (oldStorageId !== undefined) {
      this._storageIdToKittyId.delete(oldStorageId);
    }
    this._addImageOpts.scrolling = scrolling;
    this._addImageOpts.layer = layer;
    this._addImageOpts.zIndex = zIndex;
    const storageId = this._storage.addImage(image, this._addImageOpts);
    this._kittyIdToStorageId.set(kittyId, storageId);
    this._storageIdToKittyId.set(storageId, kittyId);
  }

  public getImage(kittyId: number): IKittyImageData | undefined {
    return this._images.get(kittyId);
  }

  public deleteById(kittyId: number): void {
    this._images.delete(kittyId);
    if (this._virtual.delete(kittyId)) {
      this._storage.requestRedraw();
    }
    const storageId = this._kittyIdToStorageId.get(kittyId);
    if (storageId !== undefined) {
      this._storage.deleteImage(storageId);
      this._kittyIdToStorageId.delete(kittyId);
      this._storageIdToKittyId.delete(storageId);
    }
  }

  public deleteAll(): void {
    this._images.clear();
    for (const storageId of this._kittyIdToStorageId.values()) {
      this._storage.deleteImage(storageId);
    }
    this._kittyIdToStorageId.clear();
    this._storageIdToKittyId.clear();
  }

  /**
   * Records a virtual placement of `cols` x `rows` cells. Its picture comes
   * later through `setPlaceholderImage`, once decoded.
   */
  public addVirtualPlacement(kittyId: number, placementId: number, cols: number, rows: number): IPlaceholderImage {
    let placements = this._virtual.get(kittyId);
    if (!placements) {
      placements = new Map();
      this._virtual.set(kittyId, placements);
    }
    const placement: IPlaceholderImage = { spec: undefined, cols, rows };
    placements.set(placementId, placement);
    return placement;
  }

  /** Hands a virtual placement its decoded picture and redraws placeholders. */
  public setPlaceholderImage(placement: IPlaceholderImage, spec: IImageSpec): void {
    placement.spec = spec;
    this._storage.requestRedraw();
  }

  public get size(): number {
    return this._virtual.size;
  }

  public hasLayer(layer: ImageLayer): boolean {
    for (const placements of this._virtual.values()) {
      for (const placement of placements.values()) {
        if (placement.spec?.layer === layer) {
          return true;
        }
      }
    }
    return false;
  }

  public get(imageId: number, placementId: number): IPlaceholderImage | undefined {
    const placements = this._virtual.get(imageId);
    if (!placements) {
      return undefined;
    }
    if (placementId) {
      return placements.get(placementId);
    }
    // Placement id 0: the terminal may choose any virtual placement.
    return placements.get(0) ?? placements.values().next().value;
  }

  public get images(): ReadonlyMap<number, IKittyImageData> {
    return this._images;
  }

  public get kittyIdToStorageId(): ReadonlyMap<number, number> {
    return this._kittyIdToStorageId;
  }

  public get lastImageId(): number {
    return this._nextImageId - 1;
  }

  private _evictUndisplayedImages(): void {
    for (const [kittyId] of this._images) {
      if (this._images.size <= KittyImageStorage._maxStoredImages / 2) {
        break;
      }
      if (!this._kittyIdToStorageId.has(kittyId) && !this._virtual.has(kittyId)) {
        this._images.delete(kittyId);
      }
    }
  }
}
