// Import one file: probe it, make sure this machine can actually decode it, bring it online.
import type { Id, MediaAsset } from '../core/model.ts';
import type { MediaLibrary } from '../media/library.ts';
import { MediaError, type ByteSource } from '../media/source.ts';
import type { MediaSources } from './mediaSources.ts';

/**
 * Returns the asset to add to the project. Throws MediaError (plain message) for corrupt
 * files and for formats this machine cannot decode; nothing is left attached in that case.
 */
export async function importMedia(library: MediaLibrary, media: MediaSources, source: ByteSource, id: Id, name: string, path: string): Promise<MediaAsset> {
  let asset = await library.importSource(source, id, name, path);
  try {
    if (asset.kind === 'image') {
      // The decoded bitmap is what gets drawn; it has the photo's orientation applied, the file header does not.
      const bitmap = await media.image(asset);
      if (!bitmap || !asset.video) throw new MediaError('corrupt', 'This image could not be decoded.');
      asset = { ...asset, video: { ...asset.video, width: bitmap.width, height: bitmap.height } };
    } else {
      if (asset.video) await media.video(asset);
      if (asset.audio) await media.audio(asset);
    }
    return asset;
  } catch (e) {
    library.detach(id);
    if (e instanceof MediaError) throw e;
    throw new MediaError('corrupt', asset.kind === 'image' ? 'This image could not be decoded.' : 'This file could not be opened.');
  }
}
