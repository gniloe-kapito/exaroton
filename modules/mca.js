/* =============================================================================
 *  modules/mca.js — чтение Minecraft Anvil .mca файлов и отрисовка карты
 *
 *  Формат Anvil (.mca):
 *    - Header 1 (4096 байт): 1024 entries по 4 байта = 32×32 чанков
 *        entry = 3 байта offset (big-endian) + 1 байт sector count
 *        offset = 0 → чанк не существует
 *    - Header 2 (4096 байт): timestamps (не используется)
 *    - Data: секторы по 4096 байт, чанк начинается с 4 байт длины + 1 байт compression
 *        compression: 1 = gzip, 2 = zlib (raw deflate), 3 = none
 *    - Внутри: NBT с root "Level" → Sections (16 секций по 16 блоков высоты)
 *        Для 1.18+: root содержит Sections напрямую без Level
 *
 *  Для карты берём самый верхний непустой блок каждого столбца (X,Z).
 *  Цвета блоков — упрощённая карта ~100 базовых блоков.
 *
 *  ОПТИМИЗАЦИЯ (v2):
 *   - Секции кэшируются в Int32Array при первом доступе (распаковка один раз)
 *   - BigInt не используется в горячем цикле (только при первичном чтении long array)
 *   - Рендер чанками по 1 строке (32 чанка) с await между ними — UI дышит
 *   - getTopBlock берёт Y по убыванию и сразу выходит на первом непустом блоке
 * ========================================================================== */

(function (global) {
  'use strict';

  // ── База цветов блоков ──────────────────────────────────────────
  const BLOCK_COLORS = {
    'minecraft:grass_block': [86, 152, 60],
    'minecraft:grass': [86, 152, 60],
    'minecraft:dirt': [134, 96, 67],
    'minecraft:stone': [128, 128, 128],
    'minecraft:cobblestone': [110, 110, 110],
    'minecraft:bedrock': [70, 70, 70],
    'minecraft:sand': [219, 207, 163],
    'minecraft:sandstone': [216, 200, 152],
    'minecraft:red_sand': [191, 86, 50],
    'minecraft:red_sandstone': [176, 80, 47],
    'minecraft:gravel': [136, 126, 121],
    'minecraft:clay': [160, 165, 175],
    'minecraft:snow_block': [250, 250, 250],
    'minecraft:snow': [250, 250, 250],
    'minecraft:ice': [137, 196, 235],
    'minecraft:packed_ice': [120, 180, 230],
    'minecraft:blue_ice': [80, 130, 220],
    'minecraft:water': [63, 118, 228],
    'minecraft:seagrass': [50, 110, 80],
    'minecraft:tall_seagrass': [50, 110, 80],
    'minecraft:kelp': [70, 110, 60],
    'minecraft:kelp_plant': [70, 110, 60],
    'minecraft:oak_log': [102, 76, 47],
    'minecraft:birch_log': [246, 222, 178],
    'minecraft:spruce_log': [76, 56, 36],
    'minecraft:jungle_log': [89, 67, 45],
    'minecraft:acacia_log': [101, 65, 47],
    'minecraft:dark_oak_log': [60, 41, 27],
    'minecraft:oak_leaves': [60, 110, 50],
    'minecraft:birch_leaves': [80, 130, 60],
    'minecraft:spruce_leaves': [50, 90, 50],
    'minecraft:jungle_leaves': [50, 100, 40],
    'minecraft:acacia_leaves': [110, 80, 50],
    'minecraft:dark_oak_leaves': [50, 80, 40],
    'minecraft:azalea_leaves': [90, 130, 60],
    'minecraft:flowering_azalea_leaves': [180, 130, 180],
    'minecraft:grass_plant': [86, 152, 60],
    'minecraft:tall_grass': [86, 152, 60],
    'minecraft:fern': [80, 130, 50],
    'minecraft:large_fern': [80, 130, 50],
    'minecraft:dandelion': [255, 220, 80],
    'minecraft:poppy': [220, 40, 40],
    'minecraft:blue_orchid': [40, 100, 220],
    'minecraft:allium': [180, 100, 220],
    'minecraft:azure_bluet': [220, 220, 220],
    'minecraft:red_tulip': [220, 60, 50],
    'minecraft:oxeye_daisy': [220, 220, 200],
    'minecraft:cornflower': [60, 100, 200],
    'minecraft:lily_of_the_valley': [240, 240, 240],
    'minecraft:sunflower': [255, 220, 60],
    'minecraft:rose_bush': [200, 50, 60],
    'minecraft:lilac': [180, 130, 180],
    'minecraft:peony': [240, 170, 200],
    'minecraft:coal_ore': [115, 115, 115],
    'minecraft:iron_ore': [180, 145, 110],
    'minecraft:gold_ore': [180, 150, 30],
    'minecraft:diamond_ore': [100, 200, 230],
    'minecraft:emerald_ore': [50, 200, 100],
    'minecraft:redstone_ore': [180, 40, 40],
    'minecraft:lapis_ore': [40, 70, 180],
    'minecraft:nether_quartz_ore': [200, 180, 180],
    'minecraft:ancient_debris': [110, 50, 50],
    'minecraft:netherrack': [110, 50, 50],
    'minecraft:basalt': [60, 60, 70],
    'minecraft:blackstone': [40, 40, 45],
    'minecraft:soul_sand': [80, 60, 45],
    'minecraft:soul_soil': [70, 50, 40],
    'minecraft:glowstone': [220, 180, 80],
    'minecraft:magma_block': [120, 50, 30],
    'minecraft:lava': [240, 110, 30],
    'minecraft:obsidian': [20, 15, 30],
    'minecraft:crying_obsidian': [80, 30, 120],
    'minecraft:netherite_block': [60, 50, 45],
    'minecraft:end_stone': [220, 220, 180],
    'minecraft:end_stone_bricks': [215, 215, 175],
    'minecraft:crimson_nylium': [120, 50, 70],
    'minecraft:warped_nylium': [40, 100, 110],
    'minecraft:crimson_stem': [90, 30, 50],
    'minecraft:warped_stem': [40, 90, 100],
    'minecraft:nether_wart_block': [120, 40, 50],
    'minecraft:warped_wart_block': [40, 100, 90],
    'minecraft:wheat': [180, 160, 70],
    'minecraft:carrots': [220, 140, 50],
    'minecraft:potatoes': [120, 130, 60],
    'minecraft:beetroots': [180, 60, 60],
    'minecraft:melon_stem': [80, 130, 50],
    'minecraft:pumpkin_stem': [80, 130, 50],
    'minecraft:melon': [110, 180, 50],
    'minecraft:pumpkin': [220, 140, 30],
    'minecraft:carved_pumpkin': [220, 140, 30],
    'minecraft:jack_o_lantern': [220, 140, 30],
    'minecraft:hay_block': [200, 170, 80],
    'minecraft:cocoa': [180, 100, 50],
    'minecraft:red_mushroom': [180, 50, 50],
    'minecraft:brown_mushroom': [140, 100, 70],
    'minecraft:red_mushroom_block': [180, 50, 50],
    'minecraft:brown_mushroom_block': [140, 100, 70],
    'minecraft:mushroom_stem': [220, 210, 200],
    'minecraft:oak_planks': [162, 130, 78],
    'minecraft:birch_planks': [202, 178, 130],
    'minecraft:spruce_planks': [101, 75, 47],
    'minecraft:jungle_planks': [142, 110, 65],
    'minecraft:acacia_planks': [162, 100, 60],
    'minecraft:dark_oak_planks': [70, 50, 30],
    'minecraft:bricks': [150, 100, 90],
    'minecraft:stone_bricks': [120, 120, 120],
    'minecraft:nether_bricks': [60, 30, 30],
    'minecraft:sandstone_bricks': [216, 200, 152],
    'minecraft:glass': [200, 220, 230],
    'minecraft:glass_pane': [200, 220, 230],
    'minecraft:bookshelf': [122, 90, 50],
    'minecraft:crafting_table': [140, 100, 55],
    'minecraft:furnace': [110, 110, 110],
    'minecraft:chest': [140, 100, 55],
    'minecraft:ender_chest': [80, 50, 90],
    'minecraft:iron_block': [220, 220, 220],
    'minecraft:gold_block': [255, 220, 80],
    'minecraft:diamond_block': [120, 230, 240],
    'minecraft:emerald_block': [50, 220, 110],
    'minecraft:lapis_block': [40, 70, 180],
    'minecraft:redstone_block': [180, 40, 40],
    'minecraft:coal_block': [30, 30, 30],
    'minecraft:tnt': [200, 60, 40],
    'minecraft:enchanting_table': [110, 50, 130],
    'minecraft:beacon': [100, 200, 220],
    'minecraft:conduit': [100, 200, 220],
    'minecraft:sea_lantern': [220, 220, 180],
    'minecraft:moss_block': [70, 110, 60],
    'minecraft:moss_carpet': [70, 110, 60],
    'minecraft:mycelium': [120, 100, 110],
    'minecraft:podzol': [120, 90, 50],
    'minecraft:coarse_dirt': [120, 90, 60],
    'minecraft:white_concrete': [220, 220, 220],
    'minecraft:orange_concrete': [220, 100, 30],
    'minecraft:magenta_concrete': [180, 60, 160],
    'minecraft:light_blue_concrete': [80, 160, 220],
    'minecraft:yellow_concrete': [240, 200, 30],
    'minecraft:lime_concrete': [100, 200, 50],
    'minecraft:pink_concrete': [240, 150, 170],
    'minecraft:gray_concrete': [70, 70, 70],
    'minecraft:light_gray_concrete': [160, 160, 160],
    'minecraft:cyan_concrete': [40, 130, 140],
    'minecraft:purple_concrete': [120, 50, 140],
    'minecraft:blue_concrete': [40, 60, 180],
    'minecraft:brown_concrete': [110, 75, 50],
    'minecraft:green_concrete': [80, 110, 30],
    'minecraft:red_concrete': [170, 40, 30],
    'minecraft:black_concrete': [25, 25, 25],
    'minecraft:bamboo': [110, 160, 60],
    'minecraft:bamboo_sapling': [110, 160, 60],
    'minecraft:cactus': [85, 130, 50],
    'minecraft:rail': [120, 90, 50],
    'minecraft:powered_rail': [220, 180, 30],
    'minecraft:detector_rail': [180, 130, 30],
    'minecraft:activator_rail': [180, 100, 30],
    'minecraft:farmland': [120, 90, 60],
    'minecraft:dirt_path': [150, 110, 70],
    '_unknown': [180, 180, 180],
    '_air': [255, 255, 255],
  };

  // ── NBT helpers ─────────────────────────────────────────────────
  function dvByte(view, pos) { return [view.getInt8(pos), pos + 1]; }
  function dvShort(view, pos) { return [view.getInt16(pos), pos + 2]; }
  function dvInt(view, pos) { return [view.getInt32(pos), pos + 4]; }
  function dvLong(view, pos) {
    const hi = view.getUint32(pos);
    const lo = view.getUint32(pos + 4);
    return [BigInt(hi) << 32n | BigInt(lo), pos + 8];
  }
  function dvString(view, pos) {
    const [len, p2] = dvShort(view, pos);
    const bytes = new Uint8Array(view.buffer, view.byteOffset + p2, len);
    return [new TextDecoder('utf-8').decode(bytes), p2 + len];
  }

  function readPayload(type, view, pos) {
    switch (type) {
      case 1: { const [v, p] = dvByte(view, pos); return [{ value: v }, p]; }
      case 2: { const [v, p] = dvShort(view, pos); return [{ value: v }, p]; }
      case 3: { const [v, p] = dvInt(view, pos); return [{ value: v }, p]; }
      case 4: { const [v, p] = dvLong(view, pos); return [{ value: v }, p]; }
      case 7: {
        const [len, p] = dvInt(view, pos);
        const arr = new Int8Array(view.buffer, view.byteOffset + p, len);
        return [{ value: arr, type: 'byte_array' }, p + len];
      }
      case 8: { const [v, p] = dvString(view, pos); return [{ value: v, type: 'string' }, p]; }
      case 9: {
        const [elemType, p1] = dvByte(view, pos);
        const [len, p2] = dvInt(view, p1);
        const items = []; let p = p2;
        for (let i = 0; i < len; i++) {
          const [item, np] = readPayload(elemType, view, p);
          items.push(item); p = np;
        }
        return [{ value: items, type: 'list', elementType: elemType }, p];
      }
      case 10: {
        const entries = {}; let p = pos;
        while (true) {
          const [t, p1] = dvByte(view, p); p = p1;
          if (t === 0) break;
          const [name, p2] = dvString(view, p); p = p2;
          const [val, p3] = readPayload(t, view, p); p = p3;
          entries[name] = val;
        }
        return [{ value: entries, type: 'compound' }, p];
      }
      case 11: {
        const [len, p] = dvInt(view, pos);
        const arr = []; let pp = p;
        for (let i = 0; i < len; i++) { const [v, np] = dvInt(view, pp); arr.push(v); pp = np; }
        return [{ value: arr, type: 'int_array' }, pp];
      }
      case 12: {
        const [len, p] = dvInt(view, pos);
        const arr = []; let pp = p;
        for (let i = 0; i < len; i++) { const [v, np] = dvLong(view, pp); arr.push(v); pp = np; }
        return [{ value: arr, type: 'long_array' }, pp];
      }
      default: throw new Error('Unknown NBT type: ' + type);
    }
  }

  function parseNbt(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const [type, p1] = dvByte(view, 0);
    if (type === 0) return null;
    const [name, p2] = dvString(view, p1);
    const [payload] = readPayload(type, view, p2);
    return { name, payload };
  }

  async function decompress(buffer, compressionType) {
    if (compressionType === 1) {
      const ds = new DecompressionStream('gzip');
      return new Uint8Array(await new Response(new Blob([buffer]).stream().pipeThrough(ds)).arrayBuffer());
    }
    if (compressionType === 2) {
      const ds = new DecompressionStream('deflate');
      return new Uint8Array(await new Response(new Blob([buffer]).stream().pipeThrough(ds)).arrayBuffer());
    }
    if (compressionType === 3) return new Uint8Array(buffer);
    throw new Error('Unknown compression: ' + compressionType);
  }

  // ── Парсинг MCA-файла ───────────────────────────────────────────
  // Возвращает массив 32×32 чанков, каждый уже с распакованными секциями.
  async function parseMcaFile(arrayBuffer, onProgress) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks = new Array(1024).fill(null);

    const offsets = [];
    for (let i = 0; i < 1024; i++) {
      const o = (view.getUint8(i * 4) << 16) | (view.getUint8(i * 4 + 1) << 8) | view.getUint8(i * 4 + 2);
      offsets.push(o);
    }

    const validOffsets = offsets.map((o, i) => ({ o, i })).filter(x => x.o !== 0);
    const total = validOffsets.length;
    let processed = 0;

    // Парсим по одному чанку, между ними await — UI дышит
    for (const { o: offset, i: idx } of validOffsets) {
      const dataStart = offset * 4096;
      if (dataStart + 5 > bytes.length) continue;
      const length = view.getUint32(dataStart);
      const compressionType = view.getUint8(dataStart + 4);
      const compressedData = bytes.subarray(dataStart + 5, dataStart + 4 + length);

      try {
        const decompressed = await decompress(compressedData, compressionType);
        const parsed = parseNbt(decompressed);
        if (!parsed) continue;
        const root = parsed.payload.value;
        const level = root.Level?.value || root;
        const sectionsRaw = (level.sections?.value || level.Sections?.value || []);

        // Препроцессим секции: для каждой создаем Int32Array с индексами блоков
        const sections = [];
        for (const sec of sectionsRaw) {
          const info = preprocessSection(sec);
          if (info) sections.push(info);
        }
        // Сортируем по Y (от верхних к нижним) — для getTopBlock быстрее
        sections.sort((a, b) => b.y - a.y);

        chunks[idx] = {
          sections,
          x: idx % 32,
          z: Math.floor(idx / 32),
        };
      } catch (e) {
        console.warn('[mca] chunk parse failed at', idx, e.message);
      }

      processed += 1;
      if (onProgress && (processed % 25 === 0 || processed === total)) {
        onProgress(processed, total);
        await new Promise(r => setTimeout(r, 0));
      }
    }

    return chunks;
  }

  // ── Препроцессинг секции ────────────────────────────────────────
  // Распаковывает packed long array в обычный Int32Array[4096] (16×16×16)
  // за один проход — потом getBlockAt будет O(1).
  //
  // ВАЖНО: Minecraft 1.18+ использует ВСЕ 64 бита каждого long для
  // упаковки block_states. Старая версия брала только 32 бита —
  // из-за этого вторая половина каждого long распознавалась как 0 = air.
  // Теперь используем BigInt для корректной распаковки всех 64 бит.
  function preprocessSection(section) {
    if (!section || !section.value) return null;
    const v = section.value;
    let palette, data, y;

    if (v.block_states?.value) {
      const bs = v.block_states.value;
      palette = (bs.Palette?.value || bs.palette?.value || []).map(p => p.Name?.value || p.name?.value || 'minecraft:air');
      data = bs.data?.value || bs.Data?.value;
      y = v.Y?.value ?? 0;
    } else if (v.BlockStates?.value !== undefined) {
      palette = (v.Palette?.value || []).map(p => p.Name?.value || p.name?.value || 'minecraft:air');
      data = v.BlockStates.value;
      y = v.Y?.value ?? 0;
    } else {
      return null;
    }

    if (!palette.length) return null;

    // Если палитра из 1 элемента — все блоки одинаковые
    if (palette.length === 1) {
      const blocks = new Int32Array(4096);
      blocks.fill(0);
      return { y, palette, blocks, singleBlock: palette[0] };
    }

    // Распаковываем packed long array
    const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
    const blocks = new Int32Array(4096);

    if (data && data.length) {
      // Конвертируем все longs в BigInt один раз (медленно, но это разовая операция)
      const longsBig = new Array(data.length);
      for (let i = 0; i < data.length; i++) {
        longsBig[i] = typeof data[i] === 'bigint' ? data[i] : BigInt(data[i]);
      }

      const bitsBig = BigInt(bits);
      const maskBig = (1n << bitsBig) - 1n;
      const longSizeBig = 64n;
      const totalBitsBig = BigInt(data.length) * longSizeBig;

      for (let i = 0; i < 4096; i++) {
        const bitIndexBig = BigInt(i) * bitsBig;
        if (bitIndexBig >= totalBitsBig) {
          blocks[i] = 0;
          continue;
        }

        const longIdxBig = bitIndexBig / longSizeBig;
        const bitOffsetBig = bitIndexBig % longSizeBig;
        const longIdx = Number(longIdxBig);
        const bitOffset = Number(bitOffsetBig);

        let value;
        if (bitOffset + bits <= 64) {
          // Полностью в одном long
          value = Number((longsBig[longIdx] >> bitOffsetBig) & maskBig);
        } else {
          // Пересекает границу двух longs
          const lowBits = 64 - bitOffset;
          const lowMask = (1n << BigInt(lowBits)) - 1n;
          const lowPart = Number((longsBig[longIdx] >> bitOffsetBig) & lowMask);
          let highPart = 0;
          if (longIdx + 1 < longsBig.length) {
            const highBits = bits - lowBits;
            const highMask = (1n << BigInt(highBits)) - 1n;
            highPart = Number(longsBig[longIdx + 1] & highMask);
          }
          value = lowPart | (highPart << lowBits);
        }

        blocks[i] = value < palette.length ? value : 0;
      }
    } else {
      blocks.fill(0);
    }

    return { y, palette, blocks, singleBlock: null };
  }

  // ── Получить блок на (x, y, z) в чанке — O(1) через кэш секции ──
  function getBlockAt(chunk, x, y, z) {
    if (!chunk || !chunk.sections) return 'minecraft:air';
    // Секции уже отсортированы по Y от верхних к нижним
    for (const sec of chunk.sections) {
      const secY = sec.y * 16;
      if (y >= secY && y < secY + 16) {
        if (sec.singleBlock) return sec.singleBlock;
        const localY = y - secY;
        const idx = (localY * 16 + z) * 16 + x;
        const paletteIdx = sec.blocks[idx];
        return sec.palette[paletteIdx] || 'minecraft:air';
      }
    }
    return 'minecraft:air';
  }

  // ── Найти самый верхний непустой блок в столбце (x, z) ───────────
  // Секции отсортированы сверху вниз, поэтому итерируем по секциям,
  // внутри — по Y от верха к низу. Первый непустой блок — ответ.
  function getTopBlock(chunk, x, z, maxY = 319) {
    if (!chunk) return null;
    for (const sec of chunk.sections) {
      const secYTop = sec.y * 16 + 15;
      if (secYTop > maxY) continue; // секция выше нужного Y
      const secYBottom = sec.y * 16;
      if (secYBottom > maxY) continue;
      // Идем с верхнего Y секции вниз
      const startY = Math.min(secYTop, maxY);
      for (let y = startY; y >= secYBottom; y--) {
        let block;
        if (sec.singleBlock) {
          block = sec.singleBlock;
        } else {
          const localY = y - secYBottom;
          const idx = (localY * 16 + z) * 16 + x;
          block = sec.palette[sec.blocks[idx]] || 'minecraft:air';
        }
        if (block !== 'minecraft:air') {
          return { block, y };
        }
      }
    }
    return null;
  }

  // ── Отрисовать карту региона на canvas ──────────────────────────
  // РЕНДЕР ПО ЧАНКАМ: после каждого чанка ставим await, чтобы UI дышал.
  // onProgress(chunkIdx, totalChunks) — колбек для прогресса.
  // onChunk(chunk) — колбек для сбора статистики по каждому чанку.
  async function renderMap(canvas, chunks, options = {}) {
    const showGrid = options.showGrid !== false;
    const maxY = options.maxY || 319;
    const onProgress = options.onProgress;
    const onChunk = options.onChunk;

    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');

    // Заполнить чёрным фоном
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 512, 512);

    // Считаем валидные чанки для прогресса
    const validChunkIndices = [];
    for (let i = 0; i < 1024; i++) if (chunks[i]) validChunkIndices.push(i);
    const total = validChunkIndices.length;

    // Готовим изображение 16×16 для одного чанка
    const chunkImage = ctx.createImageData(16, 16);

    let rendered = 0;
    for (const idx of validChunkIndices) {
      const cz = Math.floor(idx / 32);
      const cx = idx % 32;
      const chunk = chunks[idx];

      // Колбек для статистики (до рендера, чтобы увидеть что реально есть в чанке)
      if (onChunk) onChunk(chunk);

      // Заполняем chunkImage данными этого чанка
      const data = chunkImage.data;
      for (let bz = 0; bz < 16; bz++) {
        for (let bx = 0; bx < 16; bx++) {
          const top = getTopBlock(chunk, bx, bz, maxY);
          const pixelIdx = (bz * 16 + bx) * 4;

          if (!top) {
            // Не найден непустой блок — рисуем тёмно-серым (отличается от фона)
            data[pixelIdx] = 60;
            data[pixelIdx + 1] = 60;
            data[pixelIdx + 2] = 70;
            data[pixelIdx + 3] = 255;
          } else {
            let color = BLOCK_COLORS[top.block] || BLOCK_COLORS._unknown;
            const shade = Math.min(1.2, 0.7 + (top.y / maxY) * 0.5);
            data[pixelIdx] = Math.min(255, color[0] * shade);
            data[pixelIdx + 1] = Math.min(255, color[1] * shade);
            data[pixelIdx + 2] = Math.min(255, color[2] * shade);
            data[pixelIdx + 3] = 255;
          }
        }
      }

      // Копируем 16×16 в нужное место на главном canvas
      ctx.putImageData(chunkImage, cx * 16, cz * 16);

      rendered += 1;
      if (onProgress && (rendered % 16 === 0 || rendered === total)) {
        onProgress(rendered, total);
        // Даём UI перерисоваться + не блокирует вкладку
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Сетка чанков
    if (showGrid) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 32; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 16, 0);
        ctx.lineTo(i * 16, 512);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i * 16);
        ctx.lineTo(512, i * 16);
        ctx.stroke();
      }
    }
  }

  // ── Отрисовать СРЕЗ на конкретной высоте Y ──────────────────────
  // Берём блок на (x, sliceY, z) для каждого столбца, без поиска верхнего.
  // Полезно для просмотра пещер, шахт, конкретных слоёв руды.
  async function renderSlice(canvas, chunks, sliceY, options = {}) {
    const showGrid = options.showGrid !== false;
    const onProgress = options.onProgress;
    const onChunk = options.onChunk;

    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 512, 512);

    const validChunkIndices = [];
    for (let i = 0; i < 1024; i++) if (chunks[i]) validChunkIndices.push(i);
    const total = validChunkIndices.length;

    const chunkImage = ctx.createImageData(16, 16);

    let rendered = 0;
    for (const idx of validChunkIndices) {
      const cz = Math.floor(idx / 32);
      const cx = idx % 32;
      const chunk = chunks[idx];

      if (onChunk) onChunk(chunk);

      const data = chunkImage.data;
      for (let bz = 0; bz < 16; bz++) {
        for (let bx = 0; bx < 16; bx++) {
          const block = getBlockAt(chunk, bx, sliceY, bz);
          const pixelIdx = (bz * 16 + bx) * 4;

          if (!block || block === 'minecraft:air') {
            // Воздух или пустота — тёмный (отличается от чёрного фона)
            data[pixelIdx] = 30;
            data[pixelIdx + 1] = 30;
            data[pixelIdx + 2] = 38;
            data[pixelIdx + 3] = 255;
          } else {
            let color = BLOCK_COLORS[block] || BLOCK_COLORS._unknown;
            // Для среза нет затенения по высоте — все блоки на одном Y
            data[pixelIdx] = color[0];
            data[pixelIdx + 1] = color[1];
            data[pixelIdx + 2] = color[2];
            data[pixelIdx + 3] = 255;
          }
        }
      }

      ctx.putImageData(chunkImage, cx * 16, cz * 16);

      rendered += 1;
      if (onProgress && (rendered % 16 === 0 || rendered === total)) {
        onProgress(rendered, total);
        await new Promise(r => setTimeout(r, 0));
      }
    }

    if (showGrid) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 32; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 16, 0);
        ctx.lineTo(i * 16, 512);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i * 16);
        ctx.lineTo(512, i * 16);
        ctx.stroke();
      }
    }
  }

  // ── Получить координаты блока из клика по canvas ────────────────
  function getBlockAtPixel(canvas, px, py, chunks, mode = 'surface', sliceY = 0, maxY = 319) {
    const cx = Math.floor(px / 16);
    const cz = Math.floor(py / 16);
    const bx = px % 16;
    const bz = py % 16;
    if (cx < 0 || cx >= 32 || cz < 0 || cz >= 32) return null;
    const chunk = chunks[cz * 32 + cx];
    if (!chunk) return { cx, cz, bx, bz, top: null };
    let top;
    if (mode === 'slice') {
      const block = getBlockAt(chunk, bx, sliceY, bz);
      top = block && block !== 'minecraft:air' ? { block, y: sliceY } : null;
    } else {
      top = getTopBlock(chunk, bx, bz, maxY);
    }
    return { cx, cz, bx, bz, top };
  }

  // ── Export ──────────────────────────────────────────────────────
  global.MCA = {
    BLOCK_COLORS,
    parseMcaFile,
    getBlockAt,
    getTopBlock,
    renderMap,
    renderSlice,
    getBlockAtPixel,
  };
})(window);
