import { recognizeScreenshotText } from './vision-ocr.mjs';
import { applyBusinessDynamicSemantics, hasBusinessDynamicSemantics } from './draft-model.mjs';

const CONTAINER_TYPES = new Set([
  'navigation-bar', 'sidebar', 'drawer', 'list', 'grouped-list', 'swipe-list',
  'expandable-list', 'card', 'panel', 'section', 'form', 'table', 'status-bar',
]);
const TEXT_TYPES = new Set(['text', 'title', 'static-label', 'badge', 'status', 'breadcrumb', 'link']);
const INPUT_TYPES = new Set(['input', 'text-area', 'rich-text-input']);
const BUTTON_TYPES = new Set(['text-button', 'icon-button', 'floating-button']);
const TITLE_TEXT_TYPES = new Set(['text', 'static-label', 'title', 'subtitle', 'caption']);

function flatten(node, output = []) {
  if (!node) return output;
  output.push(node);
  for (const child of node.children || []) flatten(child, output);
  return output;
}

function normalizedText(value) {
  return String(value || '').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function textScore(left, right) {
  const a = normalizedText(left);
  const b = normalizedText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.max(0.78, Math.min(a.length, b.length) / Math.max(a.length, b.length));
  return 0;
}

function semanticTerms(element) {
  return [...new Set([
    element.label,
    ...(element.meaning?.evidence?.visibleTexts || []),
  ].map((value) => String(value || '').trim()).filter((value) => normalizedText(value).length >= 2))];
}

function resourceIds(element) {
  const ids = [];
  for (const value of element.meaning?.evidence?.visualCues || []) {
    const match = String(value || '').match(/resource-id\s*=\s*([^\s,，;；]+)/iu);
    if (match) ids.push(match[1]);
  }
  return [...new Set(ids)];
}

function normalizedDisplayBounds(bounds, viewport) {
  if (!bounds || !viewport?.width || !viewport?.height) return null;
  const left = Math.max(0, Math.min(viewport.width, Number(bounds.left)));
  const top = Math.max(0, Math.min(viewport.height, Number(bounds.top)));
  const right = Math.max(0, Math.min(viewport.width, Number(bounds.right)));
  const bottom = Math.max(0, Math.min(viewport.height, Number(bounds.bottom)));
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
  return { x: left / viewport.width, y: top / viewport.height, width: (right - left) / viewport.width, height: (bottom - top) / viewport.height };
}

function normalizedScreenshotRect(rect, width, height) {
  if (!rect || !width || !height) return null;
  const x = Math.max(0, Number(rect.x));
  const y = Math.max(0, Number(rect.y));
  const right = Math.min(width, x + Number(rect.width));
  const bottom = Math.min(height, y + Number(rect.height));
  if (![x, y, right, bottom].every(Number.isFinite) || right <= x || bottom <= y) return null;
  return { x: x / width, y: y / height, width: (right - x) / width, height: (bottom - y) / height };
}

function center(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function allModelRegions(element) {
  const regions = [element.approximateRegion];
  for (const region of element.abstraction?.instanceRegions || []) regions.push(region);
  for (const field of element.abstraction?.fields || []) {
    for (const region of field.instanceRegions || []) regions.push(region);
  }
  return regions.filter((box) => box && [box.x, box.y, box.width, box.height].every(Number.isFinite));
}

function anchorRegions(element) {
  if (element.abstraction) {
    const textRegions = (element.abstraction.fields || [])
      .filter((field) => TEXT_TYPES.has(field.elementType) || field.elementType === 'text-button')
      .flatMap((field) => field.instanceRegions || [])
      .filter(Boolean);
    if (textRegions.length > 0) return textRegions;
  }
  if (TEXT_TYPES.has(element.elementType) || element.elementType === 'text-button') return [element.approximateRegion];
  return [];
}

function uiTypeCompatible(element, node, byResourceId = false) {
  if (byResourceId) return true;
  const className = node.class || '';
  if (INPUT_TYPES.has(element.elementType)) return /EditText/i.test(className);
  if (element.elementType === 'checkbox') return /CheckBox/i.test(className);
  if (element.elementType === 'switch') return /Switch/i.test(className);
  if (element.elementType === 'radio') return /RadioButton/i.test(className);
  if (BUTTON_TYPES.has(element.elementType)) {
    // Android often exposes H5/native text actions as a non-clickable
    // TextView (the parent carries the click handler). A lexical match on the
    // exact TextView label is still authoritative for a text-button.
    return Boolean(node.clickable) || /Button|TextView/i.test(className);
  }
  return TEXT_TYPES.has(element.elementType);
}

function domTypeCompatible(element, node) {
  if (INPUT_TYPES.has(element.elementType)) return ['input', 'textarea'].includes(node.tag) || ['textbox', 'searchbox'].includes(node.role);
  // H5 checkboxes are commonly exposed as an interactive label rather than
  // an input node in the accessibility snapshot. The exact visible label is
  // still a stronger boundary than the model's estimate, so accept it here.
  if (element.elementType === 'checkbox') {
    return node.type === 'checkbox' || node.role === 'checkbox'
      || (node.interactive && node.text
        && /label|checkbox|span/i.test(`${node.tag || ''} ${node.className || ''}`));
  }
  if (element.elementType === 'switch') return node.role === 'switch';
  if (element.elementType === 'radio') return node.type === 'radio' || node.role === 'radio';
  if (BUTTON_TYPES.has(element.elementType)) return node.interactive || node.role === 'button';
  return TEXT_TYPES.has(element.elementType);
}

function selectedDomDocuments(dom) {
  const documents = Array.isArray(dom?.documents) ? dom.documents : [];
  if (documents.length === 0) return [];
  const index = Number.isInteger(dom?.selectedDocumentIndex)
    && dom.selectedDocumentIndex >= 0
    && dom.selectedDocumentIndex < documents.length
    ? dom.selectedDocumentIndex
    : 0;
  return [documents[index]];
}

function bestTextMatch(element, sources, compatible) {
  const terms = semanticTerms(element);
  const primaryTerm = String(element?.label || '').trim();
  const evidenceTerms = (element?.meaning?.evidence?.visibleTexts || [])
    .map((value) => String(value || '').trim())
    .filter((value) => normalizedText(value).length >= 2);
  const regions = allModelRegions(element);
  let best = null;
  for (const source of sources) {
    if (!source.box || !compatible(element, source)) continue;
    const score = Math.max(0, ...terms.map((term) => textScore(term, source.text)));
    if (score < 0.78) continue;
    const primaryTextScore = primaryTerm ? textScore(primaryTerm, source.text) : score;
    const evidenceTextScore = evidenceTerms.length > 0
      ? Math.max(0, ...evidenceTerms.map((term) => textScore(term, source.text)))
      : primaryTextScore;
    // Labels such as "模式说明" describe a semantic role rather than the
    // visible glyphs. Do not let that suffix match the neighbouring title when
    // the actual visible description is present elsewhere in the runtime tree.
    if (evidenceTerms.length > 0 && evidenceTextScore < 0.78 && primaryTextScore < 0.98) continue;
    const proximity = Math.min(...regions.map((region) => distance(center(region), center(source.box))));
    // A complete label match is stronger than an exact match against one
    // evidence fragment. This matters for controls whose visible label wraps
    // across multiple lines: a single line must not beat the full control.
    const rank = score + evidenceTextScore * 0.08 - Math.min(proximity, 1) * 0.12;
    if (!best || rank > best.rank) best = {
      ...source, rank, textScore: score, primaryTextScore, evidenceTextScore,
    };
  }
  return best;
}

function mergeAdjacentTextSources(sources) {
  const textSources = (sources || [])
    .filter((source) => source?.box && String(source.text || '').trim())
    .sort((left, right) => center(left.box).y - center(right.box).y || left.box.x - right.box.x);
  const combined = [];
  for (let leftIndex = 0; leftIndex < textSources.length; leftIndex += 1) {
    const left = textSources[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < textSources.length; rightIndex += 1) {
      const right = textSources[rightIndex];
      const verticalOverlap = Math.max(0, Math.min(left.box.y + left.box.height, right.box.y + right.box.height)
        - Math.max(left.box.y, right.box.y));
      const verticalRatio = verticalOverlap / Math.max(0.001, Math.min(left.box.height, right.box.height));
      if (verticalRatio < 0.45) {
        if (center(right.box).y - center(left.box).y > Math.max(left.box.height, right.box.height) * 1.8) break;
        continue;
      }
      const leftRight = left.box.x + left.box.width;
      const rightRight = right.box.x + right.box.width;
      const gap = Math.max(left.box.x, right.box.x) - Math.min(leftRight, rightRight);
      const maxGap = Math.max(0.012, Math.min(left.box.width, right.box.width) * 0.4);
      if (gap > maxGap) continue;
      const ordered = left.box.x <= right.box.x ? [left, right] : [right, left];
      const box = unionBoxes(ordered.map((source) => source.box));
      if (!box || box.width > 0.95) continue;
      combined.push({
        ...ordered[0],
        text: ordered.map((source) => String(source.text || '').trim()).join(''),
        box,
        confidence: Math.min(Number(ordered[0].confidence) || 0.9, Number(ordered[1].confidence) || 0.9),
        combined: true,
      });
    }
  }
  return [...sources, ...combined];
}

function bestInteractiveMatch(element, sources, compatible) {
  if (!element?.approximateRegion) return null;
  const region = element.approximateRegion;
  return sources
    .filter((source) => source.box && source.interactive && !source.text && compatible(element, source))
    .filter((source) => source.box.width * source.box.height < 0.2)
    .map((source) => {
      const sizeDistance = Math.abs(source.box.width - region.width) + Math.abs(source.box.height - region.height);
      const centerDistance = distance(center(region), center(source.box));
      return { source, rank: centerDistance + sizeDistance * 0.35 };
    })
    .filter(({ rank }) => rank <= 0.2)
    .sort((left, right) => left.rank - right.rank)[0]?.source || null;
}

function boxContainsBox(outer, inner, tolerance = 0.002) {
  if (!outer || !inner) return false;
  return inner.x >= outer.x - tolerance
    && inner.y >= outer.y - tolerance
    && inner.x + inner.width <= outer.x + outer.width + tolerance
    && inner.y + inner.height <= outer.y + outer.height + tolerance;
}

function orderedText(sourceList) {
  return sourceList.slice().sort((left, right) => (
    center(left.box).y - center(right.box).y || left.box.x - right.box.x
  )).map((source) => String(source.text || '').trim()).join('');
}

function enclosingInteractiveButtonBox(element, match, runtimeSources) {
  if (!element?.approximateRegion || !match?.box) return null;
  const primary = normalizedText(element.label);
  const anchorText = normalizedText(match.text);
  if (!primary && !anchorText) return null;
  const model = element.approximateRegion;
  const modelArea = model.width * model.height;

  // A flat DOM/UI snapshot does not retain parent pointers. Recover the
  // relationship from geometry: an empty interactive node that encloses the
  // matched text is a likely control ancestor, and nearby text boxes inside
  // that node are wrapped label fragments. This intentionally does not inspect
  // the words themselves, so a first-line-only model label still recovers a
  // two-line control whose second line has unrelated wording.
  const candidates = runtimeSources
    .filter((source) => source.box && source.interactive && !String(source.text || '').trim()
      && boxContainsBox(source.box, match.box, 0.002)
      && source.box.width * source.box.height <= Math.max(0.2, modelArea * 4))
    .map((source) => {
      const sourceCenter = center(source.box);
      const nearbyFragments = runtimeSources.filter((candidate) => {
        const text = normalizedText(candidate.text);
        if (candidate === source || !candidate.box || !text || !boxContainsBox(source.box, candidate.box, 0.003)) return false;
        const candidateCenter = center(candidate.box);
        const verticalGap = Math.max(0,
          Math.max(candidate.box.y - (match.box.y + match.box.height), match.box.y - (candidate.box.y + candidate.box.height)));
        const horizontalGap = Math.max(0,
          Math.max(candidate.box.x - (match.box.x + match.box.width), match.box.x - (candidate.box.x + candidate.box.width)));
        const heightRatio = Math.max(candidate.box.height / Math.max(match.box.height, 0.001),
          match.box.height / Math.max(candidate.box.height, 0.001));
        // Text fragments in one wrapped label share a line height and sit
        // close to the matched fragment on at least one axis. The generous
        // candidate-relative caps cover both vertical wrapping and adjacent
        // inline spans while rejecting distant page text in broad wrappers.
        return heightRatio <= 2.5
          && verticalGap <= Math.max(match.box.height * 1.8, source.box.height * 0.28)
          && horizontalGap <= Math.max(match.box.width * 2.5, source.box.width * 0.28)
          && (Math.abs(candidateCenter.y - center(match.box).y) <= Math.max(match.box.height * 3.2, source.box.height * 0.45)
            || Math.abs(candidateCenter.x - center(match.box).x) <= Math.max(match.box.width * 3.2, source.box.width * 0.45));
      });
      // Include the lexical anchor even when it is represented by a wrapper
      // node not present in the flat source list. Deduplicate overlapping DOM
      // wrappers so they cannot make a one-line label look multi-line.
      const lexicalFragments = runtimeSources.filter((candidate) => {
        const text = normalizedText(candidate.text);
        return candidate.box && text && boxContainsBox(source.box, candidate.box, 0.003)
          && ((primary && (primary.includes(text) || text.includes(primary)))
            || (anchorText && (anchorText.includes(text) || text.includes(anchorText))));
      });
      const fragments = [match, ...nearbyFragments, ...lexicalFragments]
        .filter((candidate, index, list) => list.indexOf(candidate) === index)
        .filter((candidate, index, list) => list.findIndex((other) => other !== candidate
          && normalizedBoxOverlap(other.box, candidate.box) >= 0.8) < 0 || index === 0);
      const fragmentBox = unionBoxes(fragments.map((candidate) => candidate.box));
      const distinctFragmentCount = fragments.length;
      const hasWrappedEvidence = distinctFragmentCount >= 2 && fragmentBox
        && (fragmentBox.height >= match.box.height * 1.35 || fragmentBox.width >= match.box.width * 1.35);
      const coverage = textScore(primary || anchorText, orderedText(lexicalFragments));
      const anchorCoverage = Math.max(
        textScore(primary, match.text),
        textScore(anchorText, match.text),
      );
      const sizeDistance = Math.abs(source.box.width - model.width) + Math.abs(source.box.height - model.height);
      const centerDistance = distance(sourceCenter, center(model));
      return {
        source,
        coverage,
        anchorCoverage,
        hasWrappedEvidence: Boolean(hasWrappedEvidence),
        fragmentCount: distinctFragmentCount,
        rank: centerDistance + sizeDistance * 0.35,
      };
    })
    .filter(({ coverage, anchorCoverage, hasWrappedEvidence, rank }) => (
      (coverage >= 0.9 || (anchorCoverage >= 0.78 && hasWrappedEvidence))
      // A model that contains a wrapped control often spans the whole row,
      // while the runtime ancestor is the narrower visual/tap boundary. Allow
      // the geometry mismatch only when multiple nearby text fragments prove
      // that the ancestor is the same multi-line control.
      && rank <= (hasWrappedEvidence ? 0.65 : 0.25)
    ))
    .sort((left, right) => (
      // Multi-line evidence is stronger than a lexical match against only the
      // first line. This is the key distinction for wrapped upload labels.
      Number(right.hasWrappedEvidence) - Number(left.hasWrappedEvidence)
      || right.coverage - left.coverage
      // Nested WebView wrappers can expose identical text coverage. Prefer
      // the slightly larger vertically enclosing control when horizontal
      // geometry is the same; this preserves all wrapped lines.
      || (Math.abs(left.source.box.width - right.source.box.width) <= 0.006
        && Math.abs(left.source.box.x - right.source.box.x) <= 0.006
        ? right.source.box.height - left.source.box.height
        : 0)
      || left.rank - right.rank
      || right.fragmentCount - left.fragmentCount
      || left.source.box.width * left.source.box.height - right.source.box.width * right.source.box.height
    ));
  if (candidates[0]) return candidates[0].source.box;

  // Some snapshots omit ancestor identity but still expose every wrapped line.
  // If the model's tap target contains the line fragments, retain that target
  // rather than collapsing it to one glyph rectangle.
  const modelFragments = runtimeSources.filter((source) => {
    const text = normalizedText(source.text);
    return source.box && text && boxContainsBox(model, source.box, 0.003)
      && ((primary && (primary.includes(text) || text.includes(primary)))
        || (anchorText && (anchorText.includes(text) || text.includes(anchorText))));
  });
  if (modelFragments.length >= 2 && textScore(primary || anchorText, orderedText(modelFragments)) >= 0.9) return model;
  return null;
}

function directMatches(elements, hierarchy, dom, coordinateViewport = hierarchy?.viewport) {
  const viewport = coordinateViewport;
  const uiSources = flatten(hierarchy?.root).filter((node) => node.bounds).map((node) => ({
    ...node,
    text: node.text || node.contentDescription || '',
    interactive: Boolean(node.clickable || node.focusable || node.checkable),
    box: normalizedDisplayBounds(node.bounds, viewport),
  })).filter((node) => node.box);
  const rawDomSources = selectedDomDocuments(dom).flatMap((document) => (document.nodes || []).map((node) => ({
    ...node,
    box: normalizedDisplayBounds(node.bounds, coordinateViewport || document.displayViewport || viewport),
  }))).filter((node) => node.box);
  const domSources = mergeAdjacentTextSources(rawDomSources);
  const matches = new Map();

  for (const element of elements) {
    const ids = resourceIds(element);
    if (ids.length > 0) {
      const candidates = uiSources.filter((node) => ids.includes(node.resourceId));
      if (candidates.length === 1 && uiTypeCompatible(element, candidates[0], true)) {
        matches.set(element.candidateKey, { ...candidates[0], source: 'ui-tree', confidence: 0.99 });
        continue;
      }
    }
    if (CONTAINER_TYPES.has(element.elementType)) continue;
    const region = element.approximateRegion;
    const uiMatch = bestTextMatch(element, uiSources, uiTypeCompatible);
    const domMatch = bestTextMatch(element, domSources, domTypeCompatible);
    // Prefer the strongest lexical match across sources. UI Automation wins
    // ties because it exposes native control semantics and exact bounds;
    // this prevents a short label such as "提交" from matching a longer DOM
    // string such as "提交时间" merely because DOM was enumerated first.
    const best = [
      uiMatch && (element.elementType !== 'icon-button' || uiMatch.textScore >= 0.98)
        && { ...uiMatch, source: 'ui-tree', confidence: 0.98 },
      domMatch && (element.elementType !== 'icon-button' || domMatch.textScore >= 0.98)
        && { ...domMatch, source: 'dom', confidence: 0.99 },
    ].filter(Boolean).sort((left, right) => (
      (right.primaryTextScore - left.primaryTextScore)
      || (right.textScore - left.textScore)
      || (right.confidence - left.confidence)
      || (left.source === 'ui-tree' ? -1 : 1)
    ))[0];
    if (best) {
      // The accessible text node for a WebView checkbox is often nested
      // inside an interactive label. Use that label's full hit area while
      // retaining the text node as the lexical match.
      if (element.elementType === 'checkbox' && best.source === 'dom') {
        const enclosingLabel = domSources
          .filter((source) => source.interactive && source.tag === 'label' && !source.text
            && containsPoint(source.box, center(best.box), 0.001))
          .sort((left, right) => (
            right.box.width * right.box.height - left.box.width * left.box.height
          ))[0];
        if (enclosingLabel) best.box = enclosingLabel.box;
      }
      if (element.elementType === 'text-button') {
        const sourcePools = best.source === 'dom'
          ? [{ source: 'dom', match: domMatch || best, sources: rawDomSources }, { source: 'ui-tree', match: uiMatch, sources: uiSources }]
          : [{ source: 'ui-tree', match: uiMatch || best, sources: uiSources }, { source: 'dom', match: domMatch, sources: rawDomSources }];
        const enclosing = sourcePools
          .filter((pool) => pool.match)
          .map((pool) => ({ ...pool, box: enclosingInteractiveButtonBox(element, pool.match, pool.sources) }))
          .find((pool) => pool.box);
        if (enclosing) {
          best.box = enclosing.box;
          best.source = enclosing.source;
          best.confidence = Math.max(Number(best.confidence) || 0.9, 0.99);
        }
      }
      matches.set(element.candidateKey, best);
      continue;
    }
    if (element.elementType === 'icon-button') {
      const uiInteractive = bestInteractiveMatch(element, uiSources, uiTypeCompatible);
      const domInteractive = bestInteractiveMatch(element, domSources, domTypeCompatible);
      const candidate = [
        uiInteractive && { ...uiInteractive, source: 'ui-tree', confidence: 0.98 },
        domInteractive && { ...domInteractive, source: 'dom', confidence: 0.99 },
      ].filter(Boolean).sort((left, right) => (
        distance(center(region), center(left.box)) - distance(center(region), center(right.box))
      ))[0];
      if (candidate) matches.set(element.candidateKey, candidate);
    }
  }
  return matches;
}

function placeholderText(value) {
  const text = String(value || '').replace(/\s+/gu, '').trim();
  if (!text || text.length > 24) return false;
  return /^(?:请|请输入|填写|选择|点击|添加|暂无|可输入|请输入)/u.test(text)
    || /(?:请填写|请输入|请选择|点击选择|选择文件)/u.test(text);
}

function inferredPlaceholderBox(box, text) {
  const value = String(text || '').replace(/\s+/gu, '').trim();
  const characterCount = Math.max(1, Array.from(value).length);
  // Native EditText exposes the whole control rather than the placeholder
  // glyph rect. Use the control's typical inner padding as a conservative
  // approximation; OCR/DOM text rectangles still take precedence.
  const width = Math.min(box.width * 0.42, Math.max(0.045, characterCount * 0.035));
  const height = Math.min(0.008, Math.max(0.004, box.height * 0.08));
  return clampBox({
    x: box.x + Math.min(box.width * 0.022, 0.018),
    y: box.y + Math.min(box.height * 0.03, 0.003),
    width,
    height,
  });
}

function runtimeAnchorSources(hierarchy, dom, coordinateViewport = hierarchy?.viewport) {
  const viewport = coordinateViewport;
  const ui = flatten(hierarchy?.root).filter((node) => node.bounds && (node.text || node.contentDescription)).map((node) => ({
    text: node.text || node.contentDescription,
    confidence: 0.98,
    source: 'ui-tree',
    box: normalizedDisplayBounds(node.bounds, viewport),
    className: String(node.class || ''),
  })).filter((node) => node.box
    && !/EditText/i.test(node.className)
    && (normalizedText(node.text).length > 0 || /^\s*[*＊✱✳]\s*$/u.test(node.text)));
  const domNodes = selectedDomDocuments(dom).flatMap((document) => (document.nodes || []).filter((node) => node.text).map((node) => ({
    text: node.text,
    confidence: 0.99,
    source: 'dom',
    box: normalizedDisplayBounds(node.bounds, coordinateViewport || document.displayViewport || viewport),
    className: `${node.tag || ''} ${node.role || ''}`,
  }))).filter((node) => node.box
    && !node.editable
    && (normalizedText(node.text).length > 0 || /^\s*[*＊✱✳]\s*$/u.test(node.text)));
  return [...mergeAdjacentTextSources(domNodes), ...ui];
}

function runtimePlaceholderSources(hierarchy, coordinateViewport = hierarchy?.viewport) {
  const viewport = coordinateViewport || hierarchy?.viewport;
  return flatten(hierarchy?.root)
    .filter((node) => node.bounds && /EditText/i.test(String(node.class || '')) && placeholderText(node.text))
    .map((node) => {
      const box = normalizedDisplayBounds(node.bounds, viewport);
      return box ? {
        text: String(node.text || '').replace(/\s+/gu, '').trim(),
        confidence: 0.95,
        source: 'ui-tree',
        box: inferredPlaceholderBox(box, node.text),
      } : null;
    }).filter(Boolean);
}

function runtimeSupplementSources(hierarchy, dom, coordinateViewport) {
  const viewport = coordinateViewport || hierarchy?.viewport;
  const structuralViewport = hierarchy?.viewport || viewport;
  const uiSources = flatten(hierarchy?.root).filter((node) => {
    const className = String(node.class || '');
    const text = String(node.text || node.contentDescription || '').trim();
    const box = node.bounds;
    const area = box && structuralViewport?.width && structuralViewport?.height
      ? ((Number(box.right) - Number(box.left)) / structuralViewport.width) * ((Number(box.bottom) - Number(box.top)) / structuralViewport.height)
      : 0;
    // WebView/root containers often expose clickable=true while representing
    // the whole surface. They are structural ancestors, never icon buttons.
    if (!text && area >= 0.45) return false;
    // Empty TextViews and generic ViewGroup nodes are implementation details
    // of H5 controls (avatar wrappers, checkbox shells, spacing views). They
    // have no independently observable semantic element and must not become
    // synthetic icon buttons merely because a parent is clickable.
    if (!text && /FrameLayout|LinearLayout|ViewGroup|android\.view\.View|WebView/i.test(className)) return false;
    if (!text && !node.resourceId && !/EditText|Button|Switch|CheckBox|RadioButton|SeekBar|ImageView|\.Image\b/i.test(className)) return false;
    return node.bounds && (node.clickable || node.checkable || /EditText|Button|Switch|CheckBox|RadioButton|SeekBar/i.test(className));
  }).map((node) => ({
    text: String(node.text || node.contentDescription || '').trim(),
    id: String(node.resourceId || '').trim(),
    interactive: true,
    disabled: node.enabled === false,
    tag: null,
    role: null,
    type: null,
    className: String(node.class || ''),
    source: 'ui-tree',
    box: normalizedDisplayBounds(node.bounds, viewport),
  }));
  const domSources = selectedDomDocuments(dom).flatMap((document) => (document.nodes || [])
    .filter((node) => node.bounds && (node.text || node.interactive || node.id))
    .map((node) => ({
      text: String(node.text || '').trim(),
      id: String(node.id || '').trim(),
      interactive: Boolean(node.interactive),
      disabled: Boolean(node.disabled),
      tag: node.tag || null,
      role: node.role || null,
      type: node.type || null,
      className: `${node.tag || ''} ${node.role || ''} ${node.type || ''} ${node.editable ? 'contenteditable' : ''}`,
      source: 'dom',
      box: normalizedDisplayBounds(node.bounds, coordinateViewport || document.displayViewport || viewport),
    })));
  const mergedDomSources = mergeAdjacentTextSources(domSources);
  const sources = [...uiSources, ...mergedDomSources]
    .filter((source) => source.box && (source.interactive || normalizedText(source.text).length >= 2));
  const combinedTextSources = sources.filter((source) => source.combined);
  const retained = [];
  for (const source of sources) {
    if (!source.combined && source.text && combinedTextSources.some((combined) => (
      combined !== source
        && normalizedText(combined.text).includes(normalizedText(source.text))
        && normalizedBoxOverlap(combined.box, source.box) >= 0.95
    ))) continue;
    const duplicate = retained.find((candidate) => {
      const sameIdentity = (source.id && candidate.id && source.id === candidate.id)
        || (source.text && candidate.text
          && normalizedText(source.text) === normalizedText(candidate.text));
      return sameIdentity && normalizedBoxOverlap(source.box, candidate.box) >= 0.65;
    });
    // UI Automation has native control semantics and is listed first; keep it
    // when the same visible node is also present in the DOM snapshot.
    if (!duplicate) retained.push(source);
  }
  return retained;
}

function normalizedBoxOverlap(left, right) {
  if (!left || !right) return 0;
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = width * height;
  const leftArea = Math.max(0, left.width) * Math.max(0, left.height);
  const rightArea = Math.max(0, right.width) * Math.max(0, right.height);
  return intersection / Math.max(0.000001, Math.min(leftArea, rightArea));
}

function normalizedBoxCoverage(region, fixedBox) {
  if (!region || !fixedBox) return 0;
  const width = Math.max(0, Math.min(region.x + region.width, fixedBox.x + fixedBox.width) - Math.max(region.x, fixedBox.x));
  const height = Math.max(0, Math.min(region.y + region.height, fixedBox.y + fixedBox.height) - Math.max(region.y, fixedBox.y));
  return (width * height) / Math.max(0.000001, region.width * region.height);
}

function runtimeInputRectangles(hierarchy, dom, coordinateViewport) {
  const viewport = coordinateViewport || hierarchy?.viewport;
  const ui = flatten(hierarchy?.root).filter((node) => node.bounds && /EditText/i.test(String(node.class || '')))
    .map((node) => ({
      box: normalizedDisplayBounds(node.bounds, viewport),
      confidence: 1,
      source: 'ui-tree',
    }));
  const domNodes = selectedDomDocuments(dom).flatMap((document) => (document.nodes || [])
    .filter((node) => node.bounds && (node.editable || ['input', 'textarea'].includes(node.tag) || ['textbox', 'searchbox'].includes(node.role)))
    .map((node) => ({
      box: normalizedDisplayBounds(node.bounds, coordinateViewport || document.displayViewport || viewport),
      confidence: 1,
      source: 'dom',
    })));
  const retained = [];
  for (const candidate of [...ui, ...domNodes].filter((item) => item.box)) {
    const duplicateIndex = retained.findIndex((existing) => normalizedBoxOverlap(existing.box, candidate.box) >= 0.75);
    if (duplicateIndex < 0) {
      retained.push(candidate);
      continue;
    }
    // Keep the UI-tree rectangle when a DOM contenteditable root describes
    // the same control. The source order above intentionally gives UI Tree
    // precedence without relying on collection order within a segment.
    if (retained[duplicateIndex].source !== 'ui-tree' && candidate.source === 'ui-tree') {
      retained[duplicateIndex] = candidate;
    }
  }
  return retained.sort((left, right) => left.box.y - right.box.y);
}

function runtimeVisualSources(hierarchy, dom, coordinateViewport) {
  const viewport = coordinateViewport || hierarchy?.viewport;
  const uiSources = flatten(hierarchy?.root).filter((node) => {
    const className = String(node.class || '');
    return node.bounds && !node.text && /ImageView|Image\b|\.Image\b/i.test(className);
  }).map((node) => ({
    source: 'ui-tree',
    tag: 'image',
    box: normalizedDisplayBounds(node.bounds, viewport),
  }));
  const domSources = selectedDomDocuments(dom).flatMap((document) => (document.nodes || [])
    .filter((node) => node.bounds && !node.text && (node.tag === 'img' || node.role === 'img'))
    .map((node) => ({
      source: 'dom',
      tag: node.tag || node.role || 'image',
      box: normalizedDisplayBounds(node.bounds, coordinateViewport || document.displayViewport || viewport),
    })));
  const retained = [];
  for (const candidate of [...uiSources, ...domSources].filter((item) => item.box)) {
    const duplicate = retained.find((existing) => normalizedBoxOverlap(existing.box, candidate.box) >= 0.75);
    if (!duplicate) retained.push(candidate);
    else if (candidate.source === 'ui-tree' && duplicate.source === 'dom') Object.assign(duplicate, candidate);
  }
  return retained;
}

function bestStandaloneAvatarSource(element, visualSources) {
  if (!element?.approximateRegion || visualSources.length === 0) return null;
  const region = element.approximateRegion;
  const candidates = visualSources
    .filter((source) => source.box && (
      regionContainsSource(region, source)
      || normalizedBoxOverlap(region, source.box) >= 0.35
    ))
    .map((source) => {
      const sourceCenter = center(source.box);
      const regionCenter = center(region);
      // Avatar rows expose several images (the main avatar, remove icon and
      // add icon). The main avatar is the visual target nearest the region's
      // leading corner; this remains stable even when the model emits the
      // whole row wrapper as the avatar box.
      const leadingCornerDistance = Math.hypot(source.box.x - region.x, source.box.y - region.y);
      const centerDistance = distance(regionCenter, sourceCenter);
      const sourcePreference = source.tag === 'img' && source.source === 'dom' ? -0.004 : 0;
      return {
        source,
        rank: leadingCornerDistance * 0.72 + centerDistance * 0.28 + sourcePreference,
      };
    })
    .sort((left, right) => left.rank - right.rank);
  const match = candidates[0];
  return match && match.rank <= 0.16 ? match.source : null;
}

const RUNTIME_AVATAR_TEXT_TYPES = new Set([
  'text', 'title', 'subtitle', 'caption', 'static-label', 'badge', 'status', 'breadcrumb', 'link',
]);

function runtimeAvatarElementTerms(element) {
  return [...new Set([
    element?.label,
    ...(element?.meaning?.evidence?.visibleTexts || []),
  ].map((value) => String(value || '').trim()).filter((value) => normalizedText(value).length >= 1))];
}

function runtimeElementOwnerKey(result, element) {
  if (!element) return null;
  const elements = result?.elements || [];
  const byKey = new Map(elements.map((candidate) => [candidate.candidateKey, candidate]));
  const explicit = (result?.relationships || [])
    .filter((relation) => relation.type === 'contains' && relation.toCandidateKey === element.candidateKey)
    .map((relation) => byKey.get(relation.fromCandidateKey))
    .filter((candidate) => candidate && CONTAINER_TYPES.has(candidate.elementType) && candidate.approximateRegion)
    .sort((left, right) => (
      left.approximateRegion.width * left.approximateRegion.height
        - right.approximateRegion.width * right.approximateRegion.height
    ));
  if (explicit[0]) return explicit[0].candidateKey;
  if (!element.approximateRegion) return null;
  return elements
    .filter((candidate) => candidate !== element
      && CONTAINER_TYPES.has(candidate.elementType)
      && candidate.approximateRegion
      && boxContainsBox(candidate.approximateRegion, element.approximateRegion, 0.003))
    .sort((left, right) => (
      left.approximateRegion.width * left.approximateRegion.height
        - right.approximateRegion.width * right.approximateRegion.height
    ))[0]?.candidateKey || null;
}

function runtimeAvatarTextPosition(imageBox, textBox) {
  if (!imageBox || !textBox) return null;
  const imageRight = imageBox.x + imageBox.width;
  const imageBottom = imageBox.y + imageBox.height;
  const textRight = textBox.x + textBox.width;
  const textBottom = textBox.y + textBox.height;
  const horizontalGap = Math.max(0,
    Math.max(textBox.x - imageRight, imageBox.x - textRight));
  const verticalGap = Math.max(0,
    Math.max(textBox.y - imageBottom, imageBox.y - textBottom));
  const verticalOverlap = Math.max(0,
    Math.min(imageBottom, textBottom) - Math.max(imageBox.y, textBox.y));
  const horizontalOverlap = Math.max(0,
    Math.min(imageRight, textRight) - Math.max(imageBox.x, textBox.x));
  const below = textBox.y >= imageBox.y + imageBox.height * 0.12;
  const beside = horizontalGap <= Math.max(0.08, imageBox.width * 1.6)
    && verticalOverlap >= Math.min(imageBox.height, textBox.height) * 0.2
    && (textBox.x >= imageRight - 0.003 || textRight <= imageBox.x + 0.003);
  // Text above an avatar with the same horizontal span is normally a section
  // heading, not the avatar's name. Names are accepted below the image or on
  // either side when their boxes share the image's cross-axis.
  if (!below && !beside) return null;
  return {
    horizontalGap,
    verticalGap,
    horizontalOverlap,
    verticalOverlap,
    below,
    beside,
  };
}

function runtimeAvatarTextSourceScore(nameElement, imageSource, source) {
  if (!nameElement?.approximateRegion || !imageSource?.box || !source?.box) return null;
  const position = runtimeAvatarTextPosition(imageSource.box, source.box);
  if (!position) return null;
  const imageBox = imageSource.box;
  const nameBox = nameElement.approximateRegion;
  const localX = Math.abs(center(source.box).x - center(imageBox).x);
  const localY = Math.abs(center(source.box).y - center(imageBox).y);
  const maxAxisGap = Math.max(0.08, imageBox.width * 1.6, source.box.width * 1.6);
  const maxCrossGap = Math.max(0.055, imageBox.height * 3.5, source.box.height * 4);
  if (position.below && position.verticalGap > maxCrossGap && localX > 0.18) return null;
  if (position.beside && position.horizontalGap > maxAxisGap && localY > 0.09) return null;
  const lexical = Math.max(0, ...runtimeAvatarElementTerms(nameElement)
    .map((term) => textScore(term, source.text)));
  const candidateOverlap = normalizedBoxOverlap(nameBox, source.box);
  const candidateContains = boxContainsBox(nameBox, source.box, 0.004)
    || boxContainsBox(source.box, nameBox, 0.004);
  const proximity = Math.min(1, distance(center(imageBox), center(source.box))
    / Math.max(0.001, maxAxisGap + maxCrossGap));
  const geometryScore = 1 - proximity;
  // Candidate geometry is deliberately significant when the model uses a
  // semantic field label rather than the observed name. Runtime text itself
  // remains mandatory, so business words never decide the merge.
  const candidateGeometryScore = Math.max(candidateOverlap, candidateContains ? 0.85 : 0);
  const score = lexical * 0.52 + geometryScore * 0.28 + candidateGeometryScore * 0.20;
  if (lexical < 0.78 && candidateGeometryScore < 0.35) return null;
  if (score < 0.52) return null;
  return {
    source,
    score,
    lexical,
    candidateGeometryScore,
    position,
  };
}

function runtimeAvatarTextSources(hierarchy, dom, coordinateViewport) {
  return runtimeSemanticNodes(hierarchy, dom, coordinateViewport)
    .filter((source) => RUNTIME_AVATAR_TEXT_TYPES.has(source.elementType || 'text')
      && runtimePayloadTextNode(source)
      && normalizedText(source.text).length >= 1);
}

function bestRuntimeAvatarTextSource(nameElement, imageSource, textSources) {
  return (textSources || [])
    .map((source) => runtimeAvatarTextSourceScore(nameElement, imageSource, source))
    .filter(Boolean)
    .sort((left, right) => (
      right.score - left.score
        || right.lexical - left.lexical
        || right.candidateGeometryScore - left.candidateGeometryScore
        || left.source.box.y - right.source.box.y
    ))[0] || null;
}

function assignRuntimeAvatarNames(avatarCandidates, nameCandidates, pairScores) {
  const rowCount = avatarCandidates.length;
  if (rowCount === 0 || nameCandidates.length === 0) return [];
  // Solve a maximum-weight one-to-one assignment. Dummy columns let an avatar
  // remain unmatched when its nearby text is ambiguous or absent.
  const columnCount = nameCandidates.length + rowCount;
  const cost = Array.from({ length: rowCount }, (_, rowIndex) => (
    Array.from({ length: columnCount }, (_, columnIndex) => {
      if (columnIndex >= nameCandidates.length) return 1;
      const score = pairScores[rowIndex][columnIndex]?.score || 0;
      return 1 - score;
    })
  ));
  const u = new Array(rowCount + 1).fill(0);
  const v = new Array(columnCount + 1).fill(0);
  const p = new Array(columnCount + 1).fill(0);
  const way = new Array(columnCount + 1).fill(0);
  for (let row = 1; row <= rowCount; row += 1) {
    p[0] = row;
    let column = 0;
    const minv = new Array(columnCount + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array(columnCount + 1).fill(false);
    do {
      used[column] = true;
      const currentRow = p[column];
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;
      for (let candidate = 1; candidate <= columnCount; candidate += 1) {
        if (used[candidate]) continue;
        const current = cost[currentRow - 1][candidate - 1] - u[currentRow] - v[candidate];
        if (current < minv[candidate]) {
          minv[candidate] = current;
          way[candidate] = column;
        }
        if (minv[candidate] < delta) {
          delta = minv[candidate];
          nextColumn = candidate;
        }
      }
      for (let candidate = 0; candidate <= columnCount; candidate += 1) {
        if (used[candidate]) {
          u[p[candidate]] += delta;
          v[candidate] -= delta;
        } else {
          minv[candidate] -= delta;
        }
      }
      column = nextColumn;
    } while (p[column] !== 0);
    do {
      const previous = way[column];
      p[column] = p[previous];
      column = previous;
    } while (column !== 0);
  }
  const rowAssignments = new Array(rowCount).fill(null);
  for (let column = 1; column <= columnCount; column += 1) {
    const row = p[column];
    if (row > 0 && row <= rowCount && column <= nameCandidates.length) {
      const pair = pairScores[row - 1][column - 1];
      if (pair?.score >= 0.52) rowAssignments[row - 1] = pair;
    }
  }
  return rowAssignments;
}

function dynamicAvatarFieldFromElement(element, key, type, region, capabilities = ['none']) {
  const normalizedCapabilities = [...new Set(capabilities.filter((value) => value && value !== 'none'))];
  const actionCapabilities = normalizedCapabilities.length > 0 ? normalizedCapabilities : ['none'];
  return {
    key,
    label: type === 'avatar-group' ? '群组头像' : (type === 'avatar' ? '头像' : '名称'),
    elementType: type,
    description: type === 'static-label' ? '动态对象的可见名称。' : '动态对象的稳定视觉图像槽位。',
    displayCondition: element.displayCondition || '存在对应动态对象时显示',
    capabilities: actionCapabilities,
    interactionBoundary: actionCapabilities.some((value) => value !== 'none') ? 'whole_element' : 'none',
    actionEffects: actionCapabilities.filter((value) => value !== 'none').map((action) => ({
      action,
      effect: action === 'tap' ? '查看或调整当前动态对象' : '对当前动态对象执行对应交互',
    })),
    parentId: element.candidateKey,
    required: false,
    instanceRegions: region ? [region] : [],
  };
}

function avatarActionCapabilities(result, candidateKey) {
  return (result?.actionCandidates || [])
    .filter((action) => action.triggerCandidateKey === candidateKey)
    .map((action) => action.action)
    .filter((action) => action && action !== 'none');
}

function runtimeAvatarField(element, type, fallbackKey, imageSource, textMatch, existingField = null) {
  const field = existingField ? { ...existingField } : dynamicAvatarFieldFromElement(
    element,
    fallbackKey,
    type,
    null,
    type === 'avatar' || type === 'avatar-group' ? avatarActionCapabilities(null, element.candidateKey) : ['none'],
  );
  field.elementType = type;
  field.parentId = element.candidateKey;
  if (imageSource?.box && !RUNTIME_AVATAR_TEXT_TYPES.has(type)) field.instanceRegions = [imageSource.box];
  if (textMatch?.source?.box && RUNTIME_AVATAR_TEXT_TYPES.has(type)) field.instanceRegions = [textMatch.source.box];
  if (!Array.isArray(field.instanceRegions)) field.instanceRegions = [];
  return field;
}

function updateDynamicAvatarTemplate(element, imageSource, textMatch, nameElement = null, result = null) {
  if (!element || !imageSource?.box) return false;
  const abstraction = element.abstraction?.kind === 'dynamic-template'
    ? { ...element.abstraction }
    : {
      kind: 'dynamic-template',
      templateKey: `${element.candidateKey}.dynamic`,
      instanceCount: 1,
      fields: [],
      instanceRegions: [],
      bboxStyle: 'abstract',
    };
  const fields = Array.isArray(abstraction.fields) ? abstraction.fields.map((field) => ({ ...field })) : [];
  const avatarIndex = fields.findIndex((field) => ['avatar', 'avatar-group'].includes(field.elementType));
  const avatarType = element.elementType === 'avatar-group' ? 'avatar-group' : 'avatar';
  const avatarField = avatarIndex >= 0
    ? runtimeAvatarField(element, avatarType, fields[avatarIndex].key, imageSource, null, fields[avatarIndex])
    : runtimeAvatarField(element, avatarType, `${element.candidateKey}_slot`, imageSource, null);
  if (avatarIndex >= 0) fields[avatarIndex] = avatarField;
  else fields.unshift(avatarField);

  let nameIndex = fields.findIndex((field) => (
    RUNTIME_AVATAR_TEXT_TYPES.has(field.elementType) && field.elementType !== 'avatar'
      && field.elementType !== 'avatar-group'
  ));
  if (textMatch?.source?.box) {
    const existingNameType = nameIndex >= 0 && RUNTIME_AVATAR_TEXT_TYPES.has(fields[nameIndex].elementType)
      ? fields[nameIndex].elementType
      : 'static-label';
    const nameField = nameIndex >= 0
      ? runtimeAvatarField(element, existingNameType, fields[nameIndex].key, imageSource, textMatch, fields[nameIndex])
      : runtimeAvatarField(element, 'static-label', `${element.candidateKey}_name_slot`, imageSource, textMatch);
    if (nameIndex >= 0) fields[nameIndex] = nameField;
    else {
      fields.push(nameField);
      nameIndex = fields.length - 1;
    }
  }
  abstraction.kind = 'dynamic-template';
  abstraction.instanceCount = 1;
  abstraction.fields = fields.map((field) => ({ ...field, parentId: element.candidateKey }));
  const fieldRegions = abstraction.fields.flatMap((field) => field.instanceRegions || []).filter(Boolean);
  const region = unionBoxes(fieldRegions.length > 0 ? fieldRegions : [imageSource.box]);
  if (!region) return false;
  abstraction.instanceRegions = [region];
  abstraction.bboxStyle = 'abstract';
  element.abstraction = abstraction;
  element.approximateRegion = region;
  element.dynamicContent = true;
  element.geometryConfidence = Math.max(Number(element.geometryConfidence) || 0.5, 0.99);
  element.riskSignals = [...new Set([...(element.riskSignals || []),
    'runtime-avatar-name-grounded', 'geometry-grounded-by-runtime', groundingSignal(imageSource.source),
  ])];
  if (textMatch?.source) element.riskSignals = [...new Set([
    ...(element.riskSignals || []), groundingSignal(textMatch.source.source),
  ])];
  if (result) {
    const avatarActions = avatarActionCapabilities(result, element.candidateKey);
    if (avatarActions.length === 0 && element.interactive) avatarActions.push('tap');
    if (avatarActions.length > 0) {
      const refreshedAvatar = abstraction.fields.find((field) => ['avatar', 'avatar-group'].includes(field.elementType));
      if (refreshedAvatar) {
        refreshedAvatar.capabilities = [...new Set(avatarActions)];
        refreshedAvatar.interactionBoundary = 'whole_element';
        refreshedAvatar.actionEffects = avatarActions.map((action) => ({
          action,
          effect: action === 'tap' ? '查看或调整当前动态对象' : '对当前动态对象执行对应交互',
        }));
      }
    }
  }
  return true;
}

function bestRuntimeAvatarSourceForElement(element, visualSources) {
  const avatarFieldRegion = (element?.abstraction?.fields || [])
    .find((field) => ['avatar', 'avatar-group'].includes(field.elementType))
    ?.instanceRegions?.find(Boolean);
  return bestStandaloneAvatarSource({
    approximateRegion: avatarFieldRegion || element?.approximateRegion,
  }, visualSources);
}

function bestExistingDynamicAvatarNameMatch(element, imageSource, textSources) {
  if (element?.abstraction?.kind !== 'dynamic-template' || !imageSource?.box) return null;
  const nameField = (element.abstraction.fields || []).find((field) => (
    RUNTIME_AVATAR_TEXT_TYPES.has(field.elementType)
      && field.elementType !== 'avatar'
      && field.elementType !== 'avatar-group'
  ));
  if (!nameField) return null;
  const region = nameField.instanceRegions?.find(Boolean) || element.approximateRegion;
  return bestRuntimeAvatarTextSource({
    ...element,
    approximateRegion: region,
    // The parent candidate's observed value is often the only lexical anchor
    // for the name field. Keep it alongside the field's semantic label.
    meaning: {
      ...(element.meaning || {}),
      evidence: {
        ...(element.meaning?.evidence || {}),
        visibleTexts: [
          ...(element.meaning?.evidence?.visibleTexts || []),
          nameField.label,
        ],
      },
    },
  }, imageSource, textSources);
}

function removeAbsorbedAvatarNameCandidates(result, absorbed, ownerMigrations) {
  if (!absorbed || absorbed.size === 0) return;
  const elements = result.elements || [];
  const keys = new Set(elements.map((element) => element.candidateKey));
  result.elements = elements.filter((element) => !absorbed.has(element.candidateKey));
  result.relationships = (result.relationships || []).filter((relation) => (
    !absorbed.has(relation.fromCandidateKey) && !absorbed.has(relation.toCandidateKey)
  ));
  result.actionCandidates = (result.actionCandidates || []).filter((action) => !absorbed.has(action.triggerCandidateKey));
  for (const migration of ownerMigrations || []) {
    if (!migration?.ownerKey || !keys.has(migration.ownerKey) || !keys.has(migration.avatarKey)) continue;
    ensureContainsRelationship(result, migration.ownerKey, migration.avatarKey);
  }
}

function mergeRuntimeAvatarNameCandidates(result, hierarchy, dom, coordinateViewport) {
  const visualSources = runtimeVisualSources(hierarchy, dom, coordinateViewport);
  const textSources = runtimeAvatarTextSources(hierarchy, dom, coordinateViewport);
  if (visualSources.length === 0 || textSources.length === 0) return 0;
  const elements = result.elements || [];
  const avatars = elements.filter((element) => (
    ['avatar', 'avatar-group'].includes(element.elementType)
      && element.approximateRegion
  ));
  if (avatars.length === 0) return 0;
  const names = elements.filter((element) => (
    RUNTIME_AVATAR_TEXT_TYPES.has(element.elementType)
      && element.approximateRegion
      && !CONTAINER_TYPES.has(element.elementType)
      && !avatars.includes(element)
      // Business-semantic inference may have already wrapped a visible name
      // in a one-field dynamic template. Keep that candidate eligible for
      // avatar/name pairing; the merged payload will absorb the name field
      // after runtime geometry confirms the relationship.
      && (element.abstraction?.kind !== 'dynamic-template'
        || hasBusinessDynamicSemantics(element))
  ));
  const avatarMatches = avatars.map((element) => ({
    element,
    image: bestRuntimeAvatarSourceForElement(element, visualSources),
  })).filter((entry) => entry.image);
  if (avatarMatches.length === 0) return 0;
  const pairScores = avatarMatches.map(({ element, image }) => names.map((name) => {
    const avatarOwner = runtimeElementOwnerKey(result, element);
    const nameOwner = runtimeElementOwnerKey(result, name);
    if (avatarOwner && nameOwner && avatarOwner !== nameOwner) return null;
    const textMatch = bestRuntimeAvatarTextSource(name, image, textSources);
    if (!textMatch) return null;
    const candidateOwnerBonus = avatarOwner && nameOwner && avatarOwner === nameOwner ? 0.04 : 0;
    return {
      ...textMatch,
      score: Math.min(1, textMatch.score + candidateOwnerBonus),
      name,
    };
  }));
  const assignments = assignRuntimeAvatarNames(
    avatarMatches.map((entry) => entry.element),
    names,
    pairScores,
  );
  const absorbed = new Set();
  const ownerMigrations = [];
  let merged = 0;
  avatarMatches.forEach(({ element, image }, index) => {
    const assignment = assignments[index] || (
      element.abstraction?.kind === 'dynamic-template'
        ? bestExistingDynamicAvatarNameMatch(element, image, textSources)
        : null
    );
    const name = assignment?.name || null;
    // A previously abstracted dynamic avatar can be recalibrated from its
    // image alone. A plain standalone avatar becomes a dynamic payload only
    // when the matching visible name is also observed.
    if (!name && element.abstraction?.kind !== 'dynamic-template') return;
    const updated = updateDynamicAvatarTemplate(element, image, assignment, name, result);
    if (!updated) return;
    merged += 1;
    const ownerKey = runtimeElementOwnerKey(result, name);
    if (name) {
      absorbed.add(name.candidateKey);
      if (ownerKey && !(result.relationships || []).some((relation) => (
        relation.type === 'contains'
          && relation.fromCandidateKey === ownerKey
          && relation.toCandidateKey === element.candidateKey
      ))) ownerMigrations.push({ ownerKey, avatarKey: element.candidateKey });
    }
  });
  removeAbsorbedAvatarNameCandidates(result, absorbed, ownerMigrations);
  return merged;
}

function groundStandaloneAvatarElements(result, hierarchy, dom, coordinateViewport) {
  const visualSources = runtimeVisualSources(hierarchy, dom, coordinateViewport);
  if (visualSources.length === 0) return 0;
  let grounded = 0;
  for (const element of result.elements || []) {
    if (!['avatar', 'avatar-group'].includes(element.elementType)
      || element.abstraction?.kind === 'dynamic-template'
      || !element.approximateRegion) continue;
    const match = bestStandaloneAvatarSource(element, visualSources);
    if (!match) continue;
    element.approximateRegion = match.box;
    element.geometryKind = element.interactive ? 'tap-target' : 'boundary';
    element.geometryConfidence = Math.max(Number(element.geometryConfidence) || 0.5, 0.99);
    element.riskSignals = [...new Set([...(element.riskSignals || []), 'geometry-grounded-by-runtime', groundingSignal(match.source)])];
    grounded += 1;
  }
  return grounded;
}

function groundDynamicVisualFields(element, hierarchy, dom, coordinateViewport) {
  if (element?.abstraction?.kind !== 'dynamic-template') return 0;
  const visualSources = runtimeVisualSources(hierarchy, dom, coordinateViewport);
  if (visualSources.length === 0) return 0;
  let count = 0;
  for (const field of element.abstraction.fields || []) {
    if (!['avatar', 'avatar-group'].includes(field.elementType)) continue;
    field.instanceRegions = (field.instanceRegions || []).map((region) => {
      if (!region) return null;
      const candidates = visualSources
        .map((source) => ({
          source,
          distance: distance(center(region), center(source.box)),
          sizeDistance: Math.abs(source.box.width - region.width) + Math.abs(source.box.height - region.height),
        }))
        .filter(({ source }) => containsPoint(element.approximateRegion || region, center(source.box), 0.02))
        .sort((left, right) => (left.distance + left.sizeDistance * 0.3) - (right.distance + right.sizeDistance * 0.3));
      const match = candidates[0]?.source;
      if (!match || candidates[0].distance > 0.08) return region;
      count += 1;
      return match.box;
    });
  }
  return count;
}

function plausibleDynamicOwner(owner, child) {
  const childRegion = child?.abstraction?.instanceRegions?.[0] || child?.approximateRegion;
  if (!owner?.approximateRegion || !childRegion) return false;
  const ownerRegion = owner.approximateRegion;
  const overlapWidth = Math.max(0, Math.min(ownerRegion.x + ownerRegion.width, childRegion.x + childRegion.width)
    - Math.max(ownerRegion.x, childRegion.x));
  const overlapHeight = Math.max(0, Math.min(ownerRegion.y + ownerRegion.height, childRegion.y + childRegion.height)
    - Math.max(ownerRegion.y, childRegion.y));
  const childArea = Math.max(0.000001, childRegion.width * childRegion.height);
  const childCoverage = overlapWidth * overlapHeight / childArea;
  // A fixed normalized tolerance is unsafe for long screenshots: 0.01 can
  // represent dozens of pixels vertically and make a nearby sibling look
  // like a child. Require actual overlap, while retaining partially clipped
  // children when at least half of their visible area belongs to the owner.
  if (childCoverage >= 0.5
    || (overlapWidth > 0 && overlapHeight > 0 && containsPoint(ownerRegion, center(childRegion), 0.001))) return true;

  // The serialized outer box can straddle a section boundary (or carry a
  // stale coordinate from a neighboring row), while one or more stable field
  // slots still land wholly inside the real owner. Admit that owner so the
  // field-level score below can resolve the relationship before clipping the
  // stale outer box.
  return dynamicFieldOwnerScore(owner, child).coveredFields > 0;
}

function dynamicFieldOwnerScore(owner, child) {
  if (!owner?.approximateRegion || !child) return { score: 0, coveredFields: 0 };
  const fields = (child.abstraction?.fields || [])
    .map((field) => ({
      field,
      regions: (field.instanceRegions || []).filter(Boolean),
    }))
    .filter(({ regions }) => regions.length > 0);
  if (fields.length === 0) return { score: 0, coveredFields: 0 };

  // A dynamic payload can be serialized with an outer box spanning two
  // adjacent sections while its stable slots still sit in one section. Score
  // each slot independently so a stale outer rectangle cannot decide the
  // owner. Visual anchors (avatars/images) and editable controls carry more
  // geometric identity than a generic text slot, but the weighting is purely
  // structural and does not inspect business labels.
  const fieldWeight = (field) => {
    if (['avatar', 'avatar-group', 'image', 'thumbnail', 'preview'].includes(field.elementType)) return 2;
    if (INPUT_TYPES.has(field.elementType)) return 1.5;
    return 1;
  };
  let weightedCoverage = 0;
  let totalWeight = 0;
  let coveredFields = 0;
  for (const { field, regions } of fields) {
    const weight = fieldWeight(field);
    const bestCoverage = Math.max(...regions.map((region) => {
      const overlapWidth = Math.max(0, Math.min(owner.approximateRegion.x + owner.approximateRegion.width, region.x + region.width)
        - Math.max(owner.approximateRegion.x, region.x));
      const overlapHeight = Math.max(0, Math.min(owner.approximateRegion.y + owner.approximateRegion.height, region.y + region.height)
        - Math.max(owner.approximateRegion.y, region.y));
      return overlapWidth * overlapHeight / Math.max(0.000001, region.width * region.height);
    }));
    weightedCoverage += bestCoverage * weight;
    totalWeight += weight;
    if (bestCoverage >= 0.5) coveredFields += 1;
  }
  return {
    score: totalWeight > 0 ? weightedCoverage / totalWeight : 0,
    coveredFields,
  };
}

function dynamicChildHasStrongOwnerEvidence(owner, child) {
  const fields = (child?.abstraction?.fields || []).filter((field) => (
    (field.instanceRegions || []).some(Boolean)
  ));
  if (fields.length === 0) return false;
  const evidence = dynamicFieldOwnerScore(owner, child);
  // One well-supported visual/input slot is enough when the remaining slot is
  // visibly stale; otherwise require most fields to agree with the owner.
  return evidence.score >= 0.55
    || evidence.coveredFields >= Math.ceil(fields.length * 0.75);
}

function dynamicOwnerForChild(result, child) {
  const elements = result.elements || [];
  const byKey = new Map(elements.map((element) => [element.candidateKey, element]));
  const candidateOwners = (result.relationships || [])
    .filter((relation) => relation.type === 'contains' && relation.toCandidateKey === child?.candidateKey)
    .map((relation) => byKey.get(relation.fromCandidateKey))
    .filter((element) => element && CONTAINER_TYPES.has(element.elementType)
      && plausibleDynamicOwner(element, child));
  const geometricOwners = elements.filter((element) => (
    element !== child
      && CONTAINER_TYPES.has(element.elementType)
      && plausibleDynamicOwner(element, child)
  ));
  const owners = [...new Set([...candidateOwners, ...geometricOwners])];
  // Prefer the deepest candidate in an explicit containment chain. Equal
  // geometry is common for semantic wrappers, so area alone cannot identify
  // the direct owner. The key tie-breaker keeps the result independent of
  // element and relationship array order when no hierarchy distinguishes it.
  const directOwners = owners.filter((owner) => !owners.some((candidate) => (
    candidate !== owner && containsPath(result, owner.candidateKey, candidate.candidateKey)
  )));
  const pool = directOwners.length > 0 ? directOwners : owners;
  const ownerScores = new Map(pool.map((owner) => [owner, dynamicFieldOwnerScore(owner, child)]));
  // Prefer the owner that contains the largest weighted share of the stable
  // fields. Keep the old area/depth tie-breakers for equal evidence and for
  // payloads that have no usable field rectangles.
  return pool.sort((left, right) => (
    (ownerScores.get(right)?.score || 0) - (ownerScores.get(left)?.score || 0)
      || (ownerScores.get(right)?.coveredFields || 0) - (ownerScores.get(left)?.coveredFields || 0)
      || left.approximateRegion.width * left.approximateRegion.height
      - right.approximateRegion.width * right.approximateRegion.height
      || left.candidateKey.localeCompare(right.candidateKey)
  ))[0] || null;
}

function dynamicChildrenOf(result, owner) {
  const elements = result.elements || [];
  return elements.filter((element) => (
    element !== owner
      && !CONTAINER_TYPES.has(element.elementType)
      && element.dynamicContent === true
      && element.abstraction?.kind === 'dynamic-template'
      && dynamicOwnerForChild(result, element) === owner
  ));
}

function pruneDynamicContainmentToOwners(result) {
  const elements = result.elements || [];
  const containerKeys = new Set(elements
    .filter((element) => CONTAINER_TYPES.has(element.elementType))
    .map((element) => element.candidateKey));
  const dynamicChildren = elements.filter((element) => (
    element.dynamicContent === true && element.abstraction?.kind === 'dynamic-template'
  ));
  const ownerByChild = new Map(dynamicChildren.map((child) => [
    child.candidateKey,
    dynamicOwnerForChild(result, child)?.candidateKey || null,
  ]));
  let removed = 0;
  result.relationships = (result.relationships || []).filter((relation) => {
    if (relation.type !== 'contains' || !ownerByChild.has(relation.toCandidateKey)
      || !containerKeys.has(relation.fromCandidateKey)) return true;
    const keep = ownerByChild.get(relation.toCandidateKey) === relation.fromCandidateKey;
    if (!keep) removed += 1;
    return keep;
  });
  for (const [childKey, ownerKey] of ownerByChild) {
    if (ownerKey) ensureContainsRelationship(result, ownerKey, childKey);
  }
  return removed;
}

function groundDynamicChildren(result, hierarchy, dom, coordinateViewport) {
  const elements = result.elements || [];
  const nodes = runtimeSemanticNodes(hierarchy, dom, coordinateViewport);
  if (nodes.length === 0) return 0;
  const visuals = runtimeVisualSources(hierarchy, dom, coordinateViewport);
  const structuralTitles = new Set(elements
    .filter((element) => CONTAINER_TYPES.has(element.elementType) && element.label)
    .map((element) => normalizedText(element.label))
    .filter(Boolean));
  let grounded = 0;
  for (const owner of elements.filter((element) => CONTAINER_TYPES.has(element.elementType) && element.approximateRegion)) {
    for (const child of dynamicChildrenOf(result, owner)) {
      const fields = child.abstraction?.fields || [];
      const usedTextSources = new Set();
      let changed = false;
      for (const field of fields) {
        const regions = field.instanceRegions || [];
        field.instanceRegions = regions.map((region) => {
          if (!region) return null;
          if (['avatar', 'avatar-group'].includes(field.elementType)) {
            const match = visuals
              .filter((source) => regionContainsSource(owner.approximateRegion, source))
              .map((source) => ({ source, rank: distance(center(region), center(source.box)) }))
              .sort((left, right) => left.rank - right.rank)[0];
            if (match && match.rank <= 0.08) { changed = true; return match.source.box; }
            return region;
          }
          if (TEXT_TYPES.has(field.elementType) || field.elementType === 'text-button') {
            // Dynamic field labels describe the slot's role, not its current
            // payload. Only explicit observed values may contribute lexical
            // evidence; geometry remains the primary signal otherwise.
            const terms = [...new Set([
              ...(field.visibleTexts || []),
              ...(field.meaning?.evidence?.visibleTexts || []),
              // Some model runs put the current dynamic payload only on the
              // parent candidate label (for example a recipient name), while
              // leaving the field label purely semantic. Treat that observed
              // value as lexical evidence so two adjacent dynamic objects
              // cannot exchange their name slots when their estimated y
              // coordinates are stale.
              ...(child.meaning?.evidence?.visibleTexts || []),
              child.label,
            ].map((value) => String(value || '').trim()).filter(Boolean))];
            const localRegion = child.abstraction?.instanceRegions?.[0] || child.approximateRegion || region;
            const match = nodes
              .filter((source) => source.text
                && regionContainsSource(owner.approximateRegion, source)
                && !usedTextSources.has(source)
                && !structuralTitles.has(normalizedText(source.text))
                && !structuralTitles.has(strippedStructuralPrefix(source.text))
                && Math.abs(center(source.box).y - center(localRegion).y) <= Math.max(0.04, localRegion.height * 1.5)
                && Math.abs(center(source.box).x - center(region).x) <= Math.max(0.25, region.width * 2))
              .map((source) => {
                const score = Math.max(...terms.map((term) => textScore(term, source.text)), 0);
                const heightCost = Math.abs(Math.log(Math.max(source.box.height, 0.001) / Math.max(region.height, 0.001)));
                const widthCost = Math.abs(source.box.width - region.width);
                const proximity = distance(center(region), center(source.box));
                return {
                  source,
                  score,
                  proximity,
                  rank: proximity * 0.72
                    + heightCost * 0.12
                    + widthCost * 0.08
                    - score * 0.12,
                };
              })
              .filter((candidate) => candidate.score >= 0.78 || candidate.proximity <= 0.06)
              .sort((left, right) => left.rank - right.rank)[0];
            if (match) {
              usedTextSources.add(match.source);
              changed = true;
              return match.source.box;
            }
          }
          return region;
        });
      }
      const childFields = fields.flatMap((field) => field.instanceRegions || []).filter(Boolean);
      const box = unionBoxes(childFields);
      if (box && changed) {
        child.abstraction.instanceRegions = [box];
        child.approximateRegion = box;
        child.geometryKind = 'boundary';
        child.geometryConfidence = Math.max(Number(child.geometryConfidence) || 0.5, 0.99);
        child.riskSignals = [...new Set([...(child.riskSignals || []), 'geometry-grounded-by-runtime'])];
        grounded += 1;
      }
    }
  }
  return grounded;
}

function expandOwnersFromGroundedDynamicFields(result) {
  let expanded = 0;
  for (const child of (result.elements || []).filter((element) => (
    element.dynamicContent === true
      && element.abstraction?.kind === 'dynamic-template'
      && element.approximateRegion
  ))) {
    const owner = dynamicOwnerForChild(result, child);
    if (!owner?.approximateRegion) continue;
    const siblingBoundary = nextStructuralBoundary(result, owner);
    const fields = (child.abstraction.fields || [])
      .flatMap((field) => (field.instanceRegions || []).filter(Boolean))
      .filter((region) => !Number.isFinite(siblingBoundary)
        || region.y < siblingBoundary - 0.001);
    const evidence = unionBoxes(fields);
    if (!evidence) continue;
    const previous = owner.approximateRegion;
    const right = Math.max(previous.x + previous.width, evidence.x + evidence.width);
    const bottom = Math.min(
      Number.isFinite(siblingBoundary) ? siblingBoundary : 1,
      Math.max(previous.y + previous.height, evidence.y + evidence.height),
    );
    const next = clampBox({
      ...previous,
      x: Math.min(previous.x, evidence.x),
      y: Math.min(previous.y, evidence.y),
      width: right - Math.min(previous.x, evidence.x),
      height: bottom - Math.min(previous.y, evidence.y),
    });
    if (Math.abs(next.y - previous.y) > 0.0001 || Math.abs(next.height - previous.height) > 0.0001
      || Math.abs(next.x - previous.x) > 0.0001 || Math.abs(next.width - previous.width) > 0.0001) {
      owner.approximateRegion = next;
      owner.riskSignals = [...new Set([...(owner.riskSignals || []), 'geometry-expanded-by-dynamic-fields'])];
      expanded += 1;
    }
  }
  return expanded;
}

function bestRuntimeInputRectangleForRegion(region, rectangles, used = new Set()) {
  if (!region || rectangles.length === 0) return null;
  const candidates = rectangles
    .filter((candidate) => !used.has(candidate))
    .map((candidate) => {
      const box = candidate.box;
      const horizontalOverlap = Math.max(0, Math.min(region.x + region.width, box.x + box.width)
        - Math.max(region.x, box.x)) / Math.max(0.001, Math.min(region.width, box.width));
      const centerDistance = distance(center(region), center(box));
      return { candidate, rank: horizontalOverlap * 1.2 - centerDistance * 0.8 };
    })
    .filter(({ candidate, rank }) => rank > 0.25
      && Math.abs(center(candidate.box).y - center(region).y) <= 0.18)
    .sort((left, right) => right.rank - left.rank);
  const match = candidates[0]?.candidate;
  return match ? { ...match, sourceRectangle: match } : null;
}

function bestRuntimeInputRectangle(element, rectangles, used = new Set()) {
  if (!INPUT_TYPES.has(element?.elementType) || !element.approximateRegion) return null;
  return bestRuntimeInputRectangleForRegion(element.approximateRegion, rectangles, used);
}

function groundAbstractInputFieldsFromRuntime(element, rectangles) {
  if (!element.abstraction || rectangles.length === 0) return 0;
  const fields = (element.abstraction.fields || []).filter((field) => INPUT_TYPES.has(field.elementType));
  const used = new Set();
  let count = 0;
  for (const field of fields) {
    field.instanceRegions = (field.instanceRegions || []).map((region) => {
      const match = bestRuntimeInputRectangleForRegion(region, rectangles, used);
      if (!match) return region;
      used.add(match.sourceRectangle);
      count += 1;
      return match.box;
    });
  }
  return count;
}

function runtimeSupplementType(source, elements = []) {
  const kind = `${source.className || ''}`.toLowerCase();
  if (/edittext|textarea|textbox|searchbox/.test(kind)) return 'text-area';
  if (/checkbox/.test(kind) || source.role === 'checkbox' || source.type === 'checkbox') return 'checkbox';
  if (source.role === 'switch' || /switch/.test(kind)) return 'switch';
  if (source.role === 'radio' || /radiobutton|radio/.test(kind)) return 'radio';
  if (source.role === 'button' || /button/.test(kind)) return source.text ? 'text-button' : 'icon-button';
  if (/image|img/.test(kind)) return 'image';
  if (/switch/.test(kind)) return 'switch';
  if (/radiobutton|radio/.test(kind)) return 'radio';
  if (/^tab\b/.test(kind) || /\btab\b/.test(kind)) return 'tab';
  const container = elements.find((element) => CONTAINER_TYPES.has(element.elementType)
    && element.approximateRegion
    && containsPoint(element.approximateRegion, center(source.box), 0.002));
  if (container && source.role === 'img') return 'image';
  if (source.interactive) return source.text ? 'text-button' : 'icon-button';
  if (/^h[1-6]\b/.test(kind) || source.box.height >= 0.045) return 'subtitle';
  return 'static-label';
}

function stableRuntimeKey(source, index) {
  const value = `${source.source}|${source.id}|${source.text}|${source.box.x.toFixed(5)}|${source.box.y.toFixed(5)}`;
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const slug = normalizedText(source.text).replace(/[^a-z0-9]+/gi, '-').slice(0, 28) || 'node';
  return `runtime_${slug}_${(hash >>> 0).toString(36)}_${index}`;
}

function regionContainsSource(region, source) {
  if (!region || !source?.box
    || ![region.x, region.y, region.width, region.height].every(Number.isFinite)) return false;
  const point = center(source.box);
  return containsPoint(region, point, 0.004);
}

function hasConcreteRuntimeCoverage(elements, source) {
  return (elements || []).some((element) => {
    // A runtime node may already be represented by a repeated-template field
    // even when its owner is a container (for example, an EditText inside a
    // section). Inspect abstract field instances before deciding to add a
    // duplicate top-level runtime element.
    const fieldRegions = (element.abstraction?.fields || [])
      .flatMap((field) => field.instanceRegions || [])
      .filter(Boolean);
    if (fieldRegions.some((region) => regionContainsSource(region, source))) return true;
    if (CONTAINER_TYPES.has(element.elementType)) return false;
    return allModelRegions(element).some((region) => regionContainsSource(region, source));
  });
}

function strippedStructuralPrefix(value) {
  return normalizedText(String(value || '').replace(/^\s*\d+\s*[.．、)]\s*/u, ''));
}

function isAlreadyRepresentedContainerText(elements, source) {
  const text = normalizedText(source.text);
  const stripped = strippedStructuralPrefix(source.text);
  if (!text && !stripped) return false;
  return (elements || []).some((element) => {
    if (!element.label || !CONTAINER_TYPES.has(element.elementType)) return false;
    const label = normalizedText(element.label);
    // Only suppress an exact structural-title duplicate. A descendant
    // control may legitimately include the container's label in its own
    // visible text (for example an action whose name starts with the section
    // title), so substring matching would hide observable runtime elements.
    return (label && (label === text || label === stripped))
      && element.approximateRegion
      && containsPoint(element.approximateRegion, center(source.box), 0.002);
  });
}

function runtimeSourceContainer(source, elements) {
  return (elements || []).find((element) => (
    CONTAINER_TYPES.has(element.elementType)
      && element.approximateRegion
      && Boolean(String(source.text || '').trim())
      && normalizedText(element.label) !== normalizedText(source.text)
      && containsPoint(element.approximateRegion, center(source.box), 0.002)
  )) || null;
}

function runtimeInteractiveTextOwner(source, sources) {
  if (!source?.box || !source.interactive || !String(source.text || '').trim()) return null;
  const textArea = source.box.width * source.box.height;
  const candidates = (sources || [])
    .filter((owner) => (
      owner !== source
        && owner?.box
        && owner.interactive
        && !String(owner.text || '').trim()
        && boxContainsBox(owner.box, source.box, 0.003)
        && owner.box.width * owner.box.height > textArea * 1.12
        // A semantic control wrapper is local to its label. Broad clickable
        // surfaces (cards, WebView roots) must not absorb every text child.
        && owner.box.width * owner.box.height <= Math.max(textArea * 8, 0.02)
    ))
    .sort((left, right) => {
      const leftStructural = /(?:^|[.\s])(?:label|button|checkbox|radio|switch|option)(?:$|[.\s])/iu.test(String(left.className || ''));
      const rightStructural = /(?:^|[.\s])(?:label|button|checkbox|radio|switch|option)(?:$|[.\s])/iu.test(String(right.className || ''));
      return Number(rightStructural) - Number(leftStructural)
        || right.box.width * right.box.height - left.box.width * left.box.height;
    });
  return candidates[0] || null;
}

function runtimeEffectiveTextSource(source, sources) {
  const owner = runtimeInteractiveTextOwner(source, sources);
  if (!owner) return source;
  const ownerClass = String(owner.className || '').trim();
  const ownerTag = String(owner.tag || '').trim().toLowerCase();
  const ownerRole = String(owner.role || '').trim().toLowerCase();
  // H5 checkbox controls are commonly represented as an interactive label
  // with a decorative span followed by the visible text. Preserve an explicit
  // role when present; infer checkbox only from that structural combination.
  const hasLeadingInteractiveChild = (sources || []).some((candidate) => (
    candidate !== source
      && candidate !== owner
      && candidate?.box
      && candidate.interactive
      && !String(candidate.text || '').trim()
      && boxContainsBox(owner.box, candidate.box, 0.003)
      && candidate.box.x <= source.box.x + 0.004
  ));
  const inferredRole = ownerRole || (
    ownerTag === 'label' && hasLeadingInteractiveChild ? 'checkbox' : ''
  );
  return {
    ...source,
    box: owner.box,
    tag: owner.tag || source.tag,
    role: inferredRole || source.role,
    type: owner.type || source.type,
    className: [ownerClass, source.className].filter(Boolean).join(' '),
    wrapperGrounded: true,
  };
}

function runtimeHasLabeledInteractiveOwner(source, sources) {
  if (!source?.box || !source.interactive || String(source.text || '').trim()) return false;
  const sourceArea = source.box.width * source.box.height;
  const visibleText = (sources || []).filter((candidate) => (
    candidate !== source
      && candidate?.box
      && String(candidate.text || '').trim()
      && boxContainsBox(source.box, candidate.box, 0.003)
  ));
  // A label/checkbox wrapper is itself observable only through its text and
  // hit area. Its nested spans/images are implementation details, not extra
  // icon actions. Keep this structural check independent of business copy.
  const structuralWrapper = /(?:^|[.\s])(?:label|checkbox|radio|switch|option)(?:$|[.\s])/iu.test(
    String(source.className || ''),
  );
  if (structuralWrapper && visibleText.length > 0) return true;

  // For generic descendants, require a larger interactive owner with the
  // same visible text payload. This avoids suppressing a standalone icon
  // button merely because an unrelated label happens to be nearby.
  return (sources || []).some((owner) => (
    owner !== source
      && owner?.box
      && owner.interactive
      && !String(owner.text || '').trim()
      && owner.box.width * owner.box.height > sourceArea * 1.15
      && boxContainsBox(owner.box, source.box, 0.002)
      && (sources || []).some((candidate) => (
        candidate !== source
          && candidate !== owner
          && candidate?.box
          && String(candidate.text || '').trim()
          && boxContainsBox(owner.box, candidate.box, 0.003)
      ))
  ));
}

function runtimePayloadInside(owner, child) {
  if (!owner?.box || !child?.box) return false;
  return boxContainsBox(owner.box, child.box, 0.003)
    || (normalizedBoxOverlap(owner.box, child.box) >= 0.35
      && containsPoint(owner.box, center(child.box), 0.003));
}

function runtimePayloadTextNode(node) {
  if (!node?.box || !String(node.text || '').trim()) return false;
  // DOM accessibility snapshots sometimes put an icon name in an image's
  // text field. It is visual evidence, not a text slot in the repeated item.
  return !/^(?:img|image|svg|path|icon)$/iu.test(String(node.tag || node.role || '').trim())
    && !/(?:^|[\s.])(?:img|image|svg|path)(?:[\s.]|$)/iu.test(String(node.className || ''));
}

function runtimeRepeatedPayload(source, textNodes, visualSources) {
  const texts = textNodes
    .filter((node) => runtimePayloadInside(source, node) && runtimePayloadTextNode(node))
    .sort((left, right) => center(left.box).y - center(right.box).y || left.box.x - right.box.x);
  const visuals = visualSources
    .filter((node) => runtimePayloadInside(source, node))
    .sort((left, right) => center(left.box).y - center(right.box).y || left.box.x - right.box.x);
  return { texts, visuals };
}

function runtimeRepeatedRowCompatible(left, right) {
  if (!left?.source?.box || !right?.source?.box) return false;
  const leftBox = left.source.box;
  const rightBox = right.source.box;
  const widthRatio = Math.max(leftBox.width, rightBox.width)
    / Math.max(0.0001, Math.min(leftBox.width, rightBox.width));
  const heightRatio = Math.max(leftBox.height, rightBox.height)
    / Math.max(0.0001, Math.min(leftBox.height, rightBox.height));
  const sameRow = verticalOverlapRatio(leftBox, rightBox) >= 0.2
    || Math.abs(center(leftBox).y - center(rightBox).y) <= Math.max(leftBox.height, rightBox.height) * 0.65;
  return sameRow
    && horizontalOverlapRatio(leftBox, rightBox) >= 0.65
    && widthRatio <= 1.45
    && heightRatio <= 2.4;
}

function runtimeRepeatedFamilyCompatible(group, row) {
  const representative = group?.representative;
  if (!representative?.source?.box || !row?.source?.box) return false;
  const left = representative.source.box;
  const right = row.source.box;
  const widthRatio = Math.max(left.width, right.width)
    / Math.max(0.0001, Math.min(left.width, right.width));
  const heightRatio = Math.max(left.height, right.height)
    / Math.max(0.0001, Math.min(left.height, right.height));
  // Repeated rows may be clipped at a stitched image edge, but their cross
  // axis and payload shape remain a stable family.
  return Math.abs(center(left).x - center(right).x) <= Math.max(0.04, left.width * 0.12)
    && widthRatio <= 1.4
    && heightRatio <= 2.4
    && Math.abs((representative.texts?.length || 0) - (row.texts?.length || 0)) <= 2
    && Math.abs((representative.visuals?.length || 0) - (row.visuals?.length || 0)) <= 2;
}

function runtimeRepeatedGroupCoherent(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return false;
  const ordered = rows.slice().sort((left, right) => left.source.box.y - right.source.box.y);
  const heights = ordered.map((row) => row.source.box.height).filter((value) => value > 0);
  const gaps = ordered.slice(1).map((row, index) => row.source.box.y
    - (ordered[index].source.box.y + ordered[index].source.box.height));
  const median = (values) => {
    const sorted = values.slice().sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] || 0;
  };
  const typicalHeight = Math.max(0.0001, median(heights));
  // A small overlap can occur when a stitched snapshot exposes a duplicate
  // fragment. Large overlap means two candidates are the same row and should
  // have been collapsed before this check.
  if (gaps.some((gap) => gap < -typicalHeight * 0.35 || gap > typicalHeight * 4.5)) return false;
  if (gaps.length >= 2) {
    const typicalGap = median(gaps);
    const tolerance = Math.max(0.012, Math.abs(typicalGap) * 0.7, typicalHeight * 1.4);
    if (gaps.some((gap) => Math.abs(gap - typicalGap) > tolerance)) return false;
  }
  // Every retained row must expose at least two independent observations, or
  // one text plus one visual anchor. Empty repeated hit areas are ambiguous
  // and remain ordinary controls instead of being silently retyped as cards.
  return ordered.every((row) => row.texts.length >= 2
    || (row.texts.length >= 1 && row.visuals.length >= 1));
}

function runtimeRepeatedGroups(sources, hierarchy, dom, coordinateViewport) {
  const textNodes = runtimeSemanticNodes(hierarchy, dom, coordinateViewport)
    .filter((node) => runtimePayloadTextNode(node));
  const visualSources = runtimeVisualSources(hierarchy, dom, coordinateViewport);
  const candidates = (sources || [])
    .filter((source) => source?.box && source.interactive && !String(source.text || '').trim())
    .filter((source) => source.box.width * source.box.height < 0.45)
    .map((source) => ({ source, ...runtimeRepeatedPayload(source, textNodes, visualSources) }))
    .filter((candidate) => candidate.texts.length >= 2
      || (candidate.texts.length >= 1 && candidate.visuals.length >= 1));
  if (candidates.length < 2) return [];

  // Collapse nested wrappers that describe one row. Prefer the larger
  // complete rectangle, with DOM winning an equal-sized UI accessibility
  // wrapper because it tracks the CSS card boundary more precisely.
  const rows = [];
  for (const candidate of candidates.slice().sort((left, right) => (
    left.source.box.y - right.source.box.y
      || right.source.box.width * right.source.box.height - left.source.box.width * left.source.box.height
  ))) {
    const matchingRows = rows.filter((row) => runtimeRepeatedRowCompatible(row, candidate));
    if (matchingRows.length === 0) {
      rows.push({ ...candidate, candidates: [candidate] });
      continue;
    }
    const row = matchingRows.sort((left, right) => (
      Math.abs(center(left.source.box).y - center(candidate.source.box).y)
        - Math.abs(center(right.source.box).y - center(candidate.source.box).y)
    ))[0];
    row.candidates.push(candidate);
    const currentArea = row.source.box.width * row.source.box.height;
    const candidateArea = candidate.source.box.width * candidate.source.box.height;
    const replace = candidateArea > currentArea * 1.08
      || (Math.abs(candidateArea - currentArea) <= currentArea * 0.08
        && candidate.source.source === 'dom' && row.source.source !== 'dom');
    if (replace) {
      row.source = candidate.source;
      row.texts = candidate.texts;
      row.visuals = candidate.visuals;
    }
  }

  const groups = [];
  for (const row of rows.sort((left, right) => left.source.box.y - right.source.box.y)) {
    const matchingGroups = groups.filter((group) => runtimeRepeatedFamilyCompatible(group, row));
    const group = matchingGroups.sort((left, right) => {
      const leftLast = left.rows.at(-1)?.source.box;
      const rightLast = right.rows.at(-1)?.source.box;
      return Math.abs((leftLast?.y || 0) - row.source.box.y)
        - Math.abs((rightLast?.y || 0) - row.source.box.y);
    })[0];
    if (group) group.rows.push(row);
    else groups.push({ representative: row, rows: [row] });
  }
  return groups
    .filter((group) => runtimeRepeatedGroupCoherent(group.rows))
    .map((group) => {
      const orderedRows = group.rows.slice().sort((left, right) => left.source.box.y - right.source.box.y);
      return {
        rows: orderedRows,
        instances: orderedRows,
        box: unionBoxes(orderedRows.map((row) => row.source.box)),
      };
    })
    .filter((group) => group.box && group.instances.length >= 2);
}

function runtimeRepeatedGroupHash(group) {
  const value = group.instances.map((row) => {
    const box = row.source.box;
    return [box.x, box.y, box.width, box.height, row.texts.length, row.visuals.length]
      .map((part) => Number(part).toFixed(5)).join(',');
  }).join('|');
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}

function runtimeCommonTextPrefix(values) {
  const prefixes = values.map((value) => String(value || '').split(/[:：]/u)[0].trim()).filter(Boolean);
  if (prefixes.length < 2) return null;
  const first = normalizedText(prefixes[0]);
  return first && prefixes.every((prefix) => normalizedText(prefix) === first) ? prefixes[0] : null;
}

function runtimeRepeatedFieldBase(rowCount, rows, itemKey) {
  const fields = [];
  const maxTextSlots = Math.max(0, ...rows.map((row) => row.texts.length));
  for (let slot = 0; slot < maxTextSlots; slot += 1) {
    const regions = rows.map((row) => row.texts[slot]?.box).filter(Boolean);
    if (regions.length < Math.max(2, Math.ceil(rowCount * 0.5))) continue;
    const values = rows.map((row) => row.texts[slot]?.text).filter(Boolean);
    const prefix = runtimeCommonTextPrefix(values);
    fields.push({
      key: `text_${slot + 1}`,
      label: prefix ? `${prefix}字段` : `文本字段${slot + 1}`,
      elementType: slot === 0 ? 'title' : 'text',
      description: '重复项中按相对位置稳定出现的可见文本槽位',
      displayCondition: '截图中可见时显示',
      capabilities: ['none'],
      interactionBoundary: 'none',
      actionEffects: [],
      parentId: itemKey,
      required: slot === 0,
      instanceRegions: regions,
    });
  }
  const maxVisualSlots = Math.max(0, ...rows.map((row) => row.visuals.length));
  for (let slot = 0; slot < maxVisualSlots; slot += 1) {
    const regions = rows.map((row) => row.visuals[slot]?.box).filter(Boolean);
    if (regions.length < Math.max(2, Math.ceil(rowCount * 0.5))) continue;
    fields.push({
      key: `image_${slot + 1}`,
      label: `图像字段${slot + 1}`,
      elementType: 'image',
      description: '重复项中按相对位置稳定出现的可见图像槽位',
      displayCondition: '截图中可见时显示',
      capabilities: ['none'],
      interactionBoundary: 'none',
      actionEffects: [],
      parentId: itemKey,
      required: false,
      instanceRegions: regions,
    });
  }
  return fields;
}

function runtimeRepeatedTemplateRepresented(elements, group) {
  return (elements || []).find((element) => {
    const instances = element.abstraction?.instanceRegions || [];
    if (element.abstraction?.kind !== 'repeated-template' || instances.length < 2) return false;
    const matched = group.instances.filter((row) => instances.some((instance) => (
      normalizedBoxOverlap(instance, row.source.box) >= 0.55
        || boxContainsBox(instance, row.source.box, 0.004)
        || boxContainsBox(row.source.box, instance, 0.004)
    )));
    return matched.length >= Math.max(2, Math.ceil(group.instances.length * 0.6));
  }) || null;
}

function uniqueRuntimeCandidateKey(base, existingKeys) {
  let key = base;
  let suffix = 1;
  while (existingKeys.has(key)) key = `${base}_${suffix++}`;
  existingKeys.add(key);
  return key;
}

function ensureRuntimeRepeatedGroup(result, group) {
  const elements = result.elements || (result.elements = []);
  const represented = runtimeRepeatedTemplateRepresented(elements, group);
  const representedSources = group.instances.flatMap((row) => [row.source, ...row.texts, ...row.visuals]);
  if (represented) {
    // Existing model templates are grounded in an earlier pass. Keep the
    // runtime payload marked as represented so supplement does not append
    // duplicate text/image candidates below the template.
    return { added: 0, representedSources };
  }
  const hash = runtimeRepeatedGroupHash(group);
  const existingKeys = new Set(elements.map((element) => element.candidateKey));
  const listKey = uniqueRuntimeCandidateKey(`runtime_repeated_list_${hash}`, existingKeys);
  const itemKey = uniqueRuntimeCandidateKey(`runtime_repeated_item_${hash}`, existingKeys);
  const listRegion = group.box;
  const owner = elements
    .filter((element) => CONTAINER_TYPES.has(element.elementType)
      && !['navigation-bar', 'status-bar'].includes(element.elementType)
      && element.approximateRegion
      && containsPoint(element.approximateRegion, center(listRegion), 0.003))
    .sort((left, right) => (
      left.approximateRegion.width * left.approximateRegion.height
        - right.approximateRegion.width * right.approximateRegion.height
    ))[0] || null;
  const evidence = (description, cues) => ({
    status: 'known',
    description,
    evidence: {
      visibleTexts: [],
      visibleIcons: [],
      visibleStates: [],
      visualCues: cues,
      userContext: null,
      unclassified: [],
    },
  });
  const list = {
    candidateKey: listKey,
    label: '运行时重复列表',
    visualDescription: '由同尺寸、同方向且含稳定可见子节点的运行时项组成的列表。',
    displayCondition: '截图中可见时显示',
    elementType: 'list',
    interactive: false,
    enabled: true,
    state: null,
    approximateRegion: listRegion,
    geometryKind: 'boundary',
    geometryConfidence: 0.99,
    meaning: evidence('运行时结构中检测到的重复列表区域。', ['重复运行时几何', '同构可见子节点']),
    dynamicContent: false,
    abstraction: null,
    riskSignals: ['geometry-grounded-by-runtime', 'runtime-repeated-structure-recovered'],
    confidence: 0.9,
  };
  const itemFields = runtimeRepeatedFieldBase(group.instances.length, group.instances, itemKey);
  const item = {
    candidateKey: itemKey,
    label: '运行时重复列表项',
    visualDescription: '由运行时同构项归纳出的列表项共相。',
    displayCondition: '截图中可见时显示',
    elementType: 'list-item',
    interactive: false,
    enabled: true,
    state: null,
    approximateRegion: listRegion,
    geometryKind: 'boundary',
    geometryConfidence: 0.99,
    meaning: evidence('重复列表中的稳定结构项。', ['重复实例边界', '可见文本或图像槽位']),
    dynamicContent: false,
    abstraction: {
      kind: 'repeated-template',
      templateKey: `runtime.${hash}.item`,
      instanceCount: group.instances.length,
      fields: itemFields,
      instanceRegions: group.instances.map((row) => row.source.box),
      bboxStyle: 'abstract',
    },
    riskSignals: ['geometry-grounded-by-runtime', 'geometry-grounded-by-repeated-runtime', 'runtime-repeated-structure-recovered'],
    confidence: 0.9,
  };
  elements.push(list, item);
  if (owner) ensureContainsRelationship(result, owner.candidateKey, listKey);
  ensureContainsRelationship(result, listKey, itemKey);
  return { added: 2, representedSources };
}

function supplementMissingRuntimeElements(result, hierarchy, dom, coordinateViewport, metrics = null) {
  const elements = result.elements || (result.elements = []);
  const sources = runtimeSupplementSources(hierarchy, dom, coordinateViewport);
  const repeatedGroups = runtimeRepeatedGroups(sources, hierarchy, dom, coordinateViewport);
  const repeatedSourceSet = new Set();
  const repeatedPayloadBoxes = [];
  let repeatedGroupCount = 0;
  for (const group of repeatedGroups) {
    const ensured = ensureRuntimeRepeatedGroup(result, group);
    repeatedGroupCount += group.instances.length;
    for (const source of ensured.representedSources) {
      if (source?.box) repeatedPayloadBoxes.push(source.box);
      if (sources.includes(source)) repeatedSourceSet.add(source);
    }
  }
  const seen = new Set();
  let added = 0;
  // Materialize visible text before empty interaction wrappers. A wrapper
  // often encloses the actual label; appending it first would make coverage
  // checks suppress the only useful semantic node.
  const orderedSources = sources.slice().sort((left, right) => (
    Number(Boolean(String(right.text || '').trim()))
      - Number(Boolean(String(left.text || '').trim()))
  ));
  for (const source of orderedSources) {
    if (repeatedSourceSet.has(source)) continue;
    // Suppress empty implementation wrappers nested inside a confirmed
    // repeated row. Their child evidence is represented by template fields;
    // treating each wrapper as an icon-button creates false actions.
    if (repeatedGroups.some((group) => group.instances.some((row) => (
      row.source !== source
        && !String(source.text || '').trim()
        && boxContainsBox(row.source.box, source.box, 0.002)
        && row.source.box.width * row.source.box.height
          > source.box.width * source.box.height * 1.2
    )))) continue;
    if (repeatedPayloadBoxes.some((box) => boxContainsBox(box, source.box, 0.003)
      || (normalizedBoxOverlap(box, source.box) >= 0.65 && containsPoint(box, center(source.box), 0.003)))) continue;
    if (runtimeHasLabeledInteractiveOwner(source, sources)) continue;
    const effectiveSource = runtimeEffectiveTextSource(source, sources);
    const sourceText = normalizedText(effectiveSource.text);
    const duplicate = sources.some((candidate) => candidate !== source
      && normalizedText(candidate.text) === sourceText
      && distance(center(candidate.box), center(effectiveSource.box)) <= 0.012
      && candidate.source !== source.source);
    if (duplicate && source.source === 'dom') continue;
    if (isAlreadyRepresentedContainerText(elements, effectiveSource)) continue;
    if (hasConcreteRuntimeCoverage(elements, effectiveSource)) continue;
    const container = runtimeSourceContainer(effectiveSource, elements);
    const key = stableRuntimeKey(effectiveSource, added);
    if (seen.has(key)) continue;
    // Canonical runtime keys intentionally converge with model keys. Never
    // append a second candidate when the model already emitted that semantic
    // element; runtime data should ground or relate it instead.
    if (elements.some((element) => element.candidateKey === key)) continue;
    seen.add(key);
    const elementType = runtimeSupplementType(effectiveSource, elements);
    const label = effectiveSource.text || (effectiveSource.id ? effectiveSource.id.split(':').pop() : null);
    const evidence = {
      visibleTexts: effectiveSource.text ? [effectiveSource.text] : [],
      visibleIcons: elementType === 'icon-button' && effectiveSource.id ? [effectiveSource.id] : [],
      visibleStates: effectiveSource.disabled ? ['禁用'] : [],
      visualCues: [effectiveSource.source === 'dom' ? 'DOM Tree 节点' : 'UI Automation 节点'],
      userContext: null,
      unclassified: [],
    };
    elements.push({
      candidateKey: key,
      label,
      visualDescription: label ? `运行时结构识别的${elementType}“${label}”。` : `运行时结构识别的${elementType}。`,
      displayCondition: '截图中可见时显示',
      elementType,
      interactive: Boolean(effectiveSource.interactive),
      enabled: effectiveSource.disabled ? false : true,
      state: effectiveSource.disabled ? 'disabled' : null,
      approximateRegion: effectiveSource.box,
      geometryKind: effectiveSource.interactive ? 'tap-target' : 'boundary',
      geometryConfidence: 0.99,
      meaning: { status: label ? 'known' : 'candidate', description: label || null, evidence },
      dynamicContent: false,
      abstraction: null,
      riskSignals: ['geometry-grounded-by-runtime', groundingSignal(effectiveSource.source), 'runtime-element-supplemented'],
      confidence: 0.9,
    });
    if (effectiveSource.interactive && !container) {
      result.actionCandidates ||= [];
      if (!result.actionCandidates.some((candidate) => candidate.triggerCandidateKey === key)) {
        result.actionCandidates.push({
          triggerCandidateKey: key,
          action: elementType === 'text-area' ? 'input' : 'tap',
          expectedOutcome: elementType === 'text-area' ? '在该输入控件中编辑文本' : '触发该控件对应的页面操作',
          basis: 'visible-affordance',
          riskSignals: [],
          confidence: 0.88,
        });
      }
    }
    added += 1;
  }
  // Keep the historical numeric return value while exposing the structural
  // recovery count through the caller's refinement metrics.
  if (metrics) metrics.repeatedGroupCount = repeatedGroupCount;
  return added;
}

function ensureContainsRelationship(result, fromCandidateKey, toCandidateKey) {
  if (!fromCandidateKey || !toCandidateKey || fromCandidateKey === toCandidateKey) return;
  result.relationships ||= [];
  const exists = result.relationships.some((relation) => (
    relation.fromCandidateKey === fromCandidateKey
      && relation.toCandidateKey === toCandidateKey
      && relation.type === 'contains'
  ));
  if (!exists) result.relationships.push({ fromCandidateKey, type: 'contains', toCandidateKey });
  // A confirmed parent-child edge is stronger than a sibling adjacency edge.
  result.relationships = result.relationships.filter((relation) => !(
    relation.fromCandidateKey === fromCandidateKey
      && relation.toCandidateKey === toCandidateKey
      && relation.type === 'adjacent-to'
  ));
}

function findElement(elements, candidateKeys, labelPattern) {
  return (elements || []).find((element) => candidateKeys.includes(element.candidateKey))
    || (elements || []).find((element) => labelPattern && labelPattern.test(String(element.label || '')));
}

function preferredTextGeometry(left, right) {
  if (!left) return right;
  if (!right) return left;
  const leftHeight = Math.max(left.box?.height || 0, 0.0001);
  const rightHeight = Math.max(right.box?.height || 0, 0.0001);
  const larger = leftHeight >= rightHeight ? left : right;
  const smaller = larger === left ? right : left;
  const heightRatio = Math.max(leftHeight, rightHeight) / Math.min(leftHeight, rightHeight);
  const widthRatio = Math.max(left.box?.width || 0, right.box?.width || 0)
    / Math.max(0.0001, Math.min(left.box?.width || 0, right.box?.width || 0));
  // A stitched UI snapshot can expose only the few pixels before a seam while
  // DOM (or the adjacent snapshot) contains the complete line. Prefer the
  // larger observation only when horizontal geometry proves it is the same
  // text line, so a large interactive ancestor cannot replace glyph bounds.
  if (heightRatio >= 2.2 && widthRatio <= 1.35 && larger.box.height <= 0.08
    && normalizedBoxOverlap(larger.box, smaller.box) >= 0.65) return larger;
  if (left.source !== right.source) {
    if (left.source === 'ui-tree') return left;
    if (right.source === 'ui-tree') return right;
  }
  return (Number(right.confidence) || 0) > (Number(left.confidence) || 0) ? right : left;
}

function runtimeSemanticNodes(hierarchy, dom, coordinateViewport = hierarchy?.viewport) {
  const viewport = coordinateViewport || hierarchy?.viewport;
  const documents = selectedDomDocuments(dom);
  const domNodes = documents.flatMap((document) => (document.nodes || []).map((node) => ({
    text: String(node.text || '').trim(),
    interactive: Boolean(node.interactive || node.role === 'button'),
    className: `${node.tag || ''} ${node.role || ''} ${node.type || ''}`,
    tag: node.tag || null,
    role: node.role || null,
    type: node.type || null,
    editable: Boolean(node.editable),
    source: 'dom',
    box: normalizedDisplayBounds(node.bounds, coordinateViewport || document.displayViewport || viewport),
  }))).filter((node) => node.box);
  const uiNodes = flatten(hierarchy?.root).filter((node) => node.bounds).map((node) => ({
    text: String(node.text || node.contentDescription || '').trim(),
    interactive: Boolean(node.clickable || node.focusable || node.checkable),
    className: String(node.class || ''),
    tag: null,
    role: null,
    type: null,
    editable: /EditText/i.test(String(node.class || '')),
    source: 'ui-tree',
    box: normalizedDisplayBounds(node.bounds, viewport),
  })).filter((node) => node.box);
  // Hybrid full-page captures use UI Automation for native chrome and DOM for
  // the stitched WebView body. Neither source is complete on its own.
  const retained = [];
  for (const node of [...domNodes, ...uiNodes]) {
    const duplicateIndex = retained.findIndex((candidate) => (
      normalizedText(candidate.text) === normalizedText(node.text)
        && normalizedText(node.text)
        && normalizedBoxOverlap(candidate.box, node.box) >= 0.65
    ));
    if (duplicateIndex < 0) retained.push(node);
    else retained[duplicateIndex] = preferredTextGeometry(retained[duplicateIndex], node);
  }
  return retained;
}

function repeatedBlockSourceCandidates(hierarchy, dom, coordinateViewport) {
  const viewport = coordinateViewport || hierarchy?.viewport;
  const uiSources = flatten(hierarchy?.root).filter((node) => node.bounds).map((node) => ({
    text: String(node.text || node.contentDescription || '').trim(),
    interactive: Boolean(node.clickable || node.focusable || node.checkable),
    className: String(node.class || ''),
    source: 'ui-tree',
    box: normalizedDisplayBounds(node.bounds, viewport),
  })).filter((source) => source.box && source.interactive && !source.text);
  const domSources = selectedDomDocuments(dom).flatMap((document) => (document.nodes || []).map((node) => ({
    text: String(node.text || '').trim(),
    interactive: Boolean(node.interactive || node.role === 'button'),
    editable: Boolean(node.editable),
    className: `${node.tag || ''} ${node.role || ''} ${node.type || ''}`,
    source: 'dom',
    box: normalizedDisplayBounds(node.bounds, coordinateViewport || document.displayViewport || viewport),
  }))).filter((source) => source.box && source.interactive && !source.text && !source.editable);
  return [...uiSources, ...domSources];
}

function verticalOverlapRatio(left, right) {
  if (!left || !right) return 0;
  const overlap = Math.max(0, Math.min(left.y + left.height, right.y + right.height)
    - Math.max(left.y, right.y));
  return overlap / Math.max(0.001, Math.min(left.height, right.height));
}

function mergeRepeatedBlockSources(sources) {
  // Empty interactive nodes include both the item container and its nested
  // implementation wrappers (avatars, checkbox shells, WebView roots). A
  // repeated-item candidate must first pass a broad-surface guard; otherwise
  // one root node can bridge every row into a single cluster.
  const candidates = (sources || []).filter((source) => {
    const box = source?.box;
    if (!box) return false;
    const area = box.width * box.height;
    return area < 0.45 && !(box.width >= 0.96 && box.height >= 0.12);
  });
  const clusters = [];
  for (const source of [...candidates].sort((left, right) => (
    left.box.y - right.box.y || left.box.x - right.box.x
  ))) {
    const sourceArea = source.box.width * source.box.height;
    // A contained, much smaller interactive node is an implementation detail
    // of an already observable item. Drop it before clustering so a nested
    // avatar/checkbox cannot enlarge or shift the item's boundary.
    const containing = candidates.find((outer) => outer !== source
      && boxContainsBox(outer.box, source.box, 0.001)
      && outer.box.width * outer.box.height >= sourceArea * 1.35
      && Math.max(outer.box.width / Math.max(source.box.width, 0.001),
        source.box.width / Math.max(outer.box.width, 0.001)) <= 1.6
      && Math.max(outer.box.height / Math.max(source.box.height, 0.001),
        source.box.height / Math.max(outer.box.height, 0.001)) <= 4);
    if (containing) continue;
    const cluster = clusters.find((candidate) => (
      horizontalOverlapRatio(candidate.box, source.box) >= 0.8
        && verticalOverlapRatio(candidate.box, source.box) >= 0.12
        && Math.max(candidate.box.width / Math.max(source.box.width, 0.001),
          source.box.width / Math.max(candidate.box.width, 0.001)) <= 1.45
        && Math.max(candidate.box.height / Math.max(source.box.height, 0.001),
          source.box.height / Math.max(candidate.box.height, 0.001)) <= 3.5
    ));
    if (!cluster) {
      clusters.push({ box: source.box, source });
      continue;
    }
    // A scroll-boundary dump can expose one card as two overlapping generic
    // View nodes. Union only strongly aligned rectangles so adjacent rows are
    // never collapsed into one instance.
    const sourceOverlap = normalizedBoxOverlap(cluster.box, source.box);
    const heightRatio = Math.max(cluster.box.height / Math.max(source.box.height, 0.001),
      source.box.height / Math.max(cluster.box.height, 0.001));
    const sameRuntimeGeometry = sourceOverlap >= 0.8
      && Math.max(cluster.box.width / Math.max(source.box.width, 0.001),
        source.box.width / Math.max(cluster.box.width, 0.001)) <= 1.2
      && heightRatio <= 2.2;
    if (sameRuntimeGeometry && source.source === 'dom' && cluster.source.source === 'ui-tree') {
      // DOM rectangles describe the WebView item's CSS border more precisely
      // than the UIAutomator accessibility wrapper (which often adds a few
      // pixels or spans a stitched scroll seam). Prefer the contained DOM box
      // instead of unioning the two and widening the right edge.
      cluster.box = source.box;
      cluster.source = source;
    } else if (sourceOverlap >= 0.75 && heightRatio <= 2.2
      && source.source === 'ui-tree' && cluster.source.source === 'dom') {
      // The same seam can yield the partial UI fragment after the complete DOM
      // item in source order. Keep the DOM boundary instead of unioning the
      // fragment's accessibility padding back into it.
      continue;
    } else {
      cluster.box = unionBoxes([cluster.box, source.box]);
      if (source.source === 'ui-tree') cluster.source = source;
    }
  }
  return clusters.map((cluster) => ({ ...cluster.source, box: cluster.box }));
}

function repeatedAxisGap(box, direction) {
  const axis = axisGeometry(box, direction);
  return axis.end - axis.start;
}

function repeatedMatchIsCoherent(sources, direction) {
  if (!Array.isArray(sources) || sources.length < 2) return false;
  const ordered = sources.slice().sort((left, right) => (
    axisPosition(left.box, direction) - axisPosition(right.box, direction)
  ));
  const sizes = ordered.map((source) => repeatedAxisGap(source.box, direction));
  const crossSizes = ordered.map((source) => direction === 'vertical' ? source.box.width : source.box.height);
  const median = (values) => {
    const sorted = values.slice().sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] || 0;
  };
  const typicalSize = Math.max(median(sizes), 0.0001);
  const typicalCross = Math.max(median(crossSizes), 0.0001);
  // A real repeated block can have a partially clipped last item, but the
  // visible item dimensions should still be in one broad family. This rejects
  // a sequence assembled from tiny avatar/checkbox wrappers.
  if (sizes.some((size) => size < typicalSize * 0.32 || size > typicalSize * 2.8)
    || crossSizes.some((size) => size < typicalCross * 0.55 || size > typicalCross * 1.8)) return false;
  const starts = ordered.map((source) => axisGeometry(source.box, direction).start);
  const deltas = starts.slice(1).map((start, index) => start - starts[index]);
  if (deltas.some((delta) => delta <= Math.max(0.0005, typicalSize * 0.12))) return false;
  if (deltas.length >= 2) {
    const typicalDelta = Math.max(median(deltas), typicalSize);
    const maxDeltaDeviation = Math.max(typicalDelta * 0.45, typicalSize * 1.2, 0.008);
    if (deltas.some((delta) => Math.abs(delta - typicalDelta) > maxDeltaDeviation)) return false;
  }
  return true;
}

function repeatedDimensionProfile(instances, dimension, direction, modelRegion) {
  const values = instances.map((instance) => Number(instance?.[dimension]))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return { value: 0, malformed: true, spread: Infinity };
  const sorted = values.slice().sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const minimum = sorted[0] || 0;
  const maximum = sorted.at(-1) || 0;
  const spread = maximum / Math.max(median, 0.0001);
  const crossDimension = direction === 'vertical' ? 'width' : 'height';
  const modelValue = Number(modelRegion?.[dimension]);
  const modelCrossValue = Number(modelRegion?.[crossDimension]);
  const expectedModelValue = Number.isFinite(modelValue) && modelValue > 0 ? modelValue : median;
  const expectedCrossValue = Number.isFinite(modelCrossValue) && modelCrossValue > 0 ? modelCrossValue : median;
  // Cross-axis dimensions should be stable for every repeated item. A wide
  // spread or an out-of-bounds instance is a strong signal that the model
  // serialized another coordinate into x/width (a common long-page failure).
  // Axis dimensions are allowed one clipped final item, so only use the outer
  // model size when the majority of values disagree with it.
  const modelDistance = Math.abs(median - expectedModelValue) / Math.max(expectedModelValue, 0.0001);
  const malformed = dimension === crossDimension
    // Out-of-bounds x/y is common when only the position was serialized
    // incorrectly; it does not by itself make a stable width/height invalid.
    // Require the dimension itself to disagree with the outer cross extent.
    ? spread > 1.45 || modelDistance > 0.35
    : spread > 2.8;
  return {
    // The outer model extent is a per-item extent only on the cross axis. On
    // the repeated axis it usually spans the whole list, so retain the median
    // item size even when one position is malformed.
    value: malformed && dimension === crossDimension ? expectedModelValue : median,
    malformed,
    spread,
    minimum,
    maximum,
    modelValue: expectedModelValue,
    modelCrossValue: expectedCrossValue,
  };
}

function remapRepeatedFieldRegion(region, previousInstance, nextInstance) {
  if (!region || !nextInstance) return region;
  if (!previousInstance || boxContainsBox(nextInstance, region, 0.003)) return region;
  const oldWidth = Math.max(previousInstance.width, 0.0001);
  const oldHeight = Math.max(previousInstance.height, 0.0001);
  const leftRatio = (region.x - previousInstance.x) / oldWidth;
  const topRatio = (region.y - previousInstance.y) / oldHeight;
  const widthRatio = region.width / oldWidth;
  const heightRatio = region.height / oldHeight;
  return clampBox({
    x: nextInstance.x + leftRatio * nextInstance.width,
    y: nextInstance.y + topRatio * nextInstance.height,
    width: Math.max(0.001, widthRatio * nextInstance.width),
    height: Math.max(0.001, heightRatio * nextInstance.height),
  });
}

function keepRepeatedFieldsInsideInstances(element) {
  const instances = element?.abstraction?.instanceRegions || [];
  if (instances.length < 2) return;
  for (const field of element.abstraction.fields || []) {
    const regions = field.instanceRegions || [];
    field.instanceRegions = regions.map((region, index) => {
      const instance = instances[index];
      if (!region || !instance || boxContainsBox(instance, region, 0.003)) return region;
      // A field can be a little wider than a card due to OCR anti-aliasing,
      // but a cross-row field is never valid. Clip only when the row overlap is
      // unambiguous; otherwise leave the evidence for the audit UI to flag.
      const overlap = normalizedBoxOverlap(instance, region);
      if (overlap >= 0.35) return intersectBoxWithOwner(region, instance);
      return region;
    });
  }
}

function repeatedBlockMatchCost(candidate, instance, direction) {
  const candidateAxis = axisPosition(candidate.box, direction);
  const instanceAxis = axisPosition(instance, direction);
  const axisScale = Math.max(0.01, instance[direction === 'vertical' ? 'height' : 'width']);
  const crossStart = direction === 'vertical' ? 'x' : 'y';
  const crossSize = direction === 'vertical' ? 'width' : 'height';
  const sizeCost = Math.abs(Math.log(Math.max(candidate.box[crossSize], 0.001)
    / Math.max(instance[crossSize], 0.001)))
    + Math.abs(Math.log(Math.max(candidate.box[direction === 'vertical' ? 'height' : 'width'], 0.001)
      / Math.max(instance[direction === 'vertical' ? 'height' : 'width'], 0.001)));
  const crossCost = Math.abs(center(candidate.box)[crossStart] - center(instance)[crossStart]);
  return Math.abs(candidateAxis - instanceAxis) / axisScale * 2.4 + sizeCost * 0.8 + crossCost * 0.2;
}

function alignRepeatedBlockSources(instances, candidates, direction) {
  if (instances.length === 0 || candidates.length < instances.length) return null;
  const orderedInstances = instances.map((instance, index) => ({ instance, index }))
    .sort((left, right) => axisPosition(left.instance, direction) - axisPosition(right.instance, direction));
  const orderedCandidates = [...candidates].sort((left, right) => (
    axisPosition(left.box, direction) - axisPosition(right.box, direction)
  ));
  const memo = new Map();
  const solve = (instanceIndex, candidateStart) => {
    if (instanceIndex >= orderedInstances.length) return { cost: 0, sources: [] };
    if (orderedCandidates.length - candidateStart < orderedInstances.length - instanceIndex) return null;
    const key = `${instanceIndex}:${candidateStart}`;
    if (memo.has(key)) return memo.get(key);
    const remaining = orderedInstances.length - instanceIndex - 1;
    let best = null;
    for (let candidateIndex = candidateStart; candidateIndex < orderedCandidates.length - remaining; candidateIndex += 1) {
      const candidate = orderedCandidates[candidateIndex];
      const next = solve(instanceIndex + 1, candidateIndex + 1);
      if (!next) continue;
      const cost = repeatedBlockMatchCost(candidate, orderedInstances[instanceIndex].instance, direction) + next.cost;
      if (!best || cost < best.cost) best = { cost, sources: [candidate, ...next.sources] };
    }
    memo.set(key, best);
    return best;
  };
  const solution = solve(0, 0);
  if (!solution) return null;
  const averageCost = solution.cost / instances.length;
  // A repeated runtime rectangle is authoritative only when its size and
  // ordered axis agree with the model's instance structure. This prevents a
  // nearby unrelated control from replacing all instances merely because it
  // happens to be repeated.
  if (averageCost > 1.8) return null;
  return orderedInstances.reduce((matched, entry, index) => {
    matched[entry.index] = solution.sources[index];
    return matched;
  }, new Array(instances.length));
}

function groundRepeatedTemplateInstances(result, hierarchy, dom, coordinateViewport, groundedElements = new Set()) {
  const elements = result.elements || [];
  const rawRepeatedSources = repeatedBlockSourceCandidates(hierarchy, dom, coordinateViewport);
  const sources = mergeRepeatedBlockSources(rawRepeatedSources);
  if (sources.length === 0) return 0;
  let count = 0;
  for (const element of elements) {
    const abstraction = element.abstraction;
    const instances = abstraction?.instanceRegions || [];
    if (!abstraction || instances.length < 2
      || !['repeated-template', 'dynamic-template'].includes(abstraction.kind)) continue;
    const modelRegion = element.approximateRegion || abstractBoundingBox(element) || unionBoxes(instances);
    if (!modelRegion) continue;
    const median = (values) => {
      const ordered = values.slice().sort((left, right) => left - right);
      return ordered[Math.floor(ordered.length / 2)] || 0;
    };
    const directions = [...new Set([repeatedTemplateDirection(instances), 'vertical', 'horizontal'])];
    const matches = directions.map((direction) => {
      const modelAxis = axisGeometry(modelRegion, direction);
      const modelAxisSize = direction === 'vertical' ? 'height' : 'width';
      const modelCrossSize = direction === 'vertical' ? 'width' : 'height';
      const axisProfile = repeatedDimensionProfile(instances, modelAxisSize, direction, modelRegion);
      const crossProfile = repeatedDimensionProfile(instances, modelCrossSize, direction, modelRegion);
      const expectedAxisSize = axisProfile.value || median(instances.map((instance) => instance[modelAxisSize]));
      const expectedCrossSize = crossProfile.value || median(instances.map((instance) => instance[modelCrossSize]));
      const modelCrossCenter = modelAxis.crossStart + (modelAxis.crossEnd - modelAxis.crossStart) / 2;
      const candidates = sources.filter((candidate) => {
        const axis = axisGeometry(candidate.box, direction);
        const axisSize = axis.end - axis.start;
        const crossSize = axis.crossEnd - axis.crossStart;
        const axisRatio = axisSize / Math.max(0.001, expectedAxisSize);
        const crossRatio = crossSize / Math.max(0.001, expectedCrossSize);
        const axisCenter = (axis.start + axis.end) / 2;
        const tolerance = Math.max(expectedAxisSize * 1.5, 0.06);
        // The model's outer x can drift (in particular when a long-page y
        // value is accidentally written into x). Use dimensions and the
        // repeated axis as evidence, but allow a small cross-axis correction;
        // requiring full containment here would make an otherwise reliable
        // runtime card group impossible to recover.
        const crossDistance = Math.abs((axis.crossStart + axis.crossEnd) / 2 - modelCrossCenter);
        const crossTolerance = Math.max(expectedCrossSize * 0.8, 0.16);
        return axisRatio >= 0.35 && axisRatio <= 3
          && crossRatio >= 0.45 && crossRatio <= 1.8
          && crossDistance <= crossTolerance
          && axisCenter >= modelAxis.start - tolerance
          && axisCenter <= modelAxis.end + tolerance;
      });
      const matched = alignRepeatedBlockSources(instances, candidates, direction);
      if (!matched || !repeatedMatchIsCoherent(matched, direction)) return null;
      const cost = matched.reduce((sum, source, index) => (
        sum + repeatedBlockMatchCost(source, instances[index], direction)
      ), 0) / instances.length;
      return { direction, matched, cost };
    }).filter(Boolean).sort((left, right) => left.cost - right.cost)[0];
    const matched = matches?.matched;
    if (!matched) continue;
    const boxes = matched.map((source) => source.box).filter(Boolean);
    if (boxes.length !== instances.length) continue;
    for (const field of abstraction.fields || []) {
      field.instanceRegions = (field.instanceRegions || []).map((region, index) => (
        remapRepeatedFieldRegion(region, instances[index], boxes[index])
      ));
    }
    abstraction.instanceRegions = boxes;
    element.approximateRegion = unionBoxes(boxes);
    element.geometryKind = element.interactive ? 'tap-target' : 'boundary';
    element.geometryConfidence = Math.max(Number(element.geometryConfidence) || 0.5, 0.99);
    element.riskSignals = [...new Set([...(element.riskSignals || []),
      'geometry-grounded-by-runtime', 'geometry-grounded-by-repeated-runtime'])];
    groundedElements.add(element);
    count += boxes.length;
  }
  return count;
}

function containsPath(result, fromCandidateKey, toCandidateKey) {
  if (!fromCandidateKey || !toCandidateKey || fromCandidateKey === toCandidateKey) return false;
  const adjacency = new Map();
  for (const relation of result.relationships || []) {
    if (relation.type !== 'contains') continue;
    const children = adjacency.get(relation.fromCandidateKey) || [];
    children.push(relation.toCandidateKey);
    adjacency.set(relation.fromCandidateKey, children);
  }
  const pending = [...(adjacency.get(fromCandidateKey) || [])];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === toCandidateKey) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(adjacency.get(current) || []));
  }
  return false;
}

function directContainerOwner(result, element) {
  if (!element?.approximateRegion) return null;
  const byKey = new Map((result.elements || []).map((candidate) => [candidate.candidateKey, candidate]));
  return (result.relationships || [])
    .filter((relation) => relation.type === 'contains' && relation.toCandidateKey === element.candidateKey)
    .map((relation) => byKey.get(relation.fromCandidateKey))
    .filter((candidate) => candidate && CONTAINER_TYPES.has(candidate.elementType)
      && candidate.approximateRegion
      && containsPoint(candidate.approximateRegion, center(element.approximateRegion), 0.01))
    .sort((left, right) => (
      left.approximateRegion.width * left.approximateRegion.height
        - right.approximateRegion.width * right.approximateRegion.height
    ))[0] || null;
}

function sameContainerLevel(result, left, right) {
  if (!left?.approximateRegion || !right?.approximateRegion) return false;
  if (containsPath(result, left.candidateKey, right.candidateKey)
    || containsPath(result, right.candidateKey, left.candidateKey)
    || boxContainsBox(left.approximateRegion, right.approximateRegion, 0.003)
    || boxContainsBox(right.approximateRegion, left.approximateRegion, 0.003)) return false;
  return directContainerOwner(result, left)?.candidateKey === directContainerOwner(result, right)?.candidateKey;
}

function horizontalOverlapRatio(left, right) {
  if (!left || !right) return 0;
  const overlap = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  return overlap / Math.max(0.001, Math.min(left.width, right.width));
}

function navigationBarEvidence(result, element) {
  const directRelations = (result.relationships || []).filter((relation) => (
    relation.fromCandidateKey === element.candidateKey
      && ['contains', 'labels'].includes(relation.type)
  ));
  const visibleTextCount = [
    ...(element.meaning?.evidence?.visibleTexts || []),
    ...(element.meaning?.evidence?.visibleIcons || []),
  ].filter((value) => String(value || '').trim()).length;
  const grounded = (element.riskSignals || []).some((signal) => (
    signal === 'geometry-grounded-by-runtime'
      || signal === 'geometry-grounded-by-ui-tree'
      || signal === 'geometry-grounded-by-dom'
  ));
  return directRelations.length * 3
    + visibleTextCount
    + (grounded ? 2 : 0)
    + Math.min(1, Number(element.geometryConfidence) || 0);
}

function navigationBarsOverlap(left, right) {
  if (!left?.approximateRegion || !right?.approximateRegion) return false;
  const a = left.approximateRegion;
  const b = right.approximateRegion;
  const verticalOverlap = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const horizontalOverlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const verticalRatio = verticalOverlap / Math.max(0.001, Math.min(a.height, b.height));
  const horizontalRatio = horizontalOverlap / Math.max(0.001, Math.min(a.width, b.width));
  const areaOverlap = normalizedBoxOverlap(a, b);
  if (areaOverlap >= 0.62 && verticalRatio >= 0.55 && horizontalRatio >= 0.65) return true;

  // A stale runtime/root candidate can be a full-width wrapper around the
  // real bar. It is a duplicate only when it is materially taller and the
  // smaller bar is wholly inside it; this does not collapse adjacent top and
  // bottom navigation bars, which have disjoint vertical intervals.
  const [outer, inner] = a.width * a.height >= b.width * b.height ? [a, b] : [b, a];
  return outer.width >= 0.8
    && outer.height >= 0.12
    && inner.width >= 0.6
    && boxContainsBox(outer, inner, 0.004);
}

function navigationRuntimeBandEvidence(result, navigation, hierarchy, dom, coordinateViewport) {
  const nodes = runtimeSemanticNodes(hierarchy, dom, coordinateViewport);
  if (nodes.length === 0) return null;
  const terms = semanticTerms(navigation);
  if (terms.length === 0) return null;
  const anchors = nodes
    .map((node) => ({
      node,
      score: Math.max(0, ...terms.map((term) => textScore(term, node.text))),
    }))
    .filter(({ node, score }) => node.text && score >= 0.78);
  if (anchors.length === 0) return null;

  // Repeated content may contain one of the navigation words as well. Keep
  // anchors in compact horizontal bands so a distant body occurrence cannot
  // pull a navigation candidate away from the actual chrome.
  const groups = [];
  for (const anchor of anchors.sort((left, right) => left.node.box.y - right.node.box.y)) {
    const group = groups.find((candidate) => candidate.some((item) => (
      verticalOverlapRatio(item.node.box, anchor.node.box) >= 0.3
        || Math.abs(center(item.node.box).y - center(anchor.node.box).y)
          <= Math.max(0.004, Math.max(item.node.box.height, anchor.node.box.height) * 1.5)
    )));
    if (group) group.push(anchor);
    else groups.push([anchor]);
  }
  const rankedGroups = groups.map((group) => {
    const box = unionBoxes(group.map(({ node }) => node.box));
    const edgeDistance = box ? Math.min(box.y, 1 - (box.y + box.height)) : 1;
    const score = group.reduce((total, item) => total + item.score, 0);
    // Edge proximity is a tie-breaker only. A custom in-page toolbar can be
    // valid, while a malformed full-height candidate should still prefer the
    // compact runtime band that contains its own lexical evidence.
    return {
      group,
      box,
      rank: group.length * 2 + score + Math.max(0, 0.2 - edgeDistance),
    };
  }).filter((candidate) => candidate.box
    // A full-page navigation box is necessarily malformed. In that case use
    // only runtime bands at the viewport edges; body content can repeat the
    // same short title or action text and must not become navigation evidence.
    && (navigation.approximateRegion.height <= 0.18
      || Math.min(candidate.box.y, 1 - (candidate.box.y + candidate.box.height)) <= 0.2))
    .sort((left, right) => right.rank - left.rank);
  const selected = rankedGroups[0];
  if (!selected?.box) return null;

  const verticalPadding = Math.max(0.002, Math.min(0.02, selected.box.height * 0.2));
  const bandTop = Math.max(0, selected.box.y - verticalPadding);
  const bandBottom = Math.min(1, selected.box.y + selected.box.height + verticalPadding);
  const bandNodes = nodes.filter((node) => {
    if (!node.box || node.box.width * node.box.height > 0.2 || node.box.height > 0.18) return false;
    const overlap = Math.max(0, Math.min(node.box.y + node.box.height, bandBottom)
      - Math.max(node.box.y, bandTop));
    const overlapRatio = overlap / Math.max(0.001, Math.min(node.box.height, bandBottom - bandTop));
    return overlapRatio >= 0.25
      || (node.interactive && Math.abs(center(node.box).y - center(selected.box).y) <= verticalPadding);
  });
  const evidenceBox = unionBoxes([selected.box, ...bandNodes.map((node) => node.box)]);
  if (!evidenceBox || evidenceBox.height > 0.18) return null;
  if (selected.group.length < 2 && !bandNodes.some((node) => node.interactive && !node.text)) return null;

  // Map runtime evidence back to already-recognized candidates where possible
  // so a repaired navigation bar keeps its semantic child relationships even
  // when an earlier stale boundary caused pruneOutOfBoundsContainment to drop
  // those edges.
  const evidenceElements = (result.elements || []).filter((element) => (
    element !== navigation
      && !CONTAINER_TYPES.has(element.elementType)
      && element.approximateRegion
      && (element.riskSignals || []).includes('geometry-grounded-by-runtime')
      && bandNodes.some((node) => normalizedBoxOverlap(element.approximateRegion, node.box) >= 0.45)
  ));
  return { box: evidenceBox, elements: evidenceElements };
}

function deduplicateNavigationBars(result) {
  const elements = result.elements || [];
  const candidates = elements.filter((element) => (
    element.elementType === 'navigation-bar' && element.approximateRegion
  ));
  if (candidates.length < 2) return 0;

  const parent = new Map(candidates.map((element) => [element, element]));
  const find = (element) => {
    let current = element;
    while (parent.get(current) !== current) {
      parent.set(current, parent.get(parent.get(current)));
      current = parent.get(current);
    }
    return current;
  };
  const join = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      if (navigationBarsOverlap(candidates[leftIndex], candidates[rightIndex])) {
        join(candidates[leftIndex], candidates[rightIndex]);
      }
    }
  }
  const groups = new Map();
  for (const candidate of candidates) {
    const root = find(candidate);
    const group = groups.get(root) || [];
    group.push(candidate);
    groups.set(root, group);
  }

  const replacements = new Map();
  const removed = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keeper = group.slice().sort((left, right) => {
      const leftRootArtifact = left.candidateKey?.startsWith('runtime_') ? 1 : 0;
      const rightRootArtifact = right.candidateKey?.startsWith('runtime_') ? 1 : 0;
      const leftOversized = left.approximateRegion.width >= 0.8 && left.approximateRegion.height >= 0.12 ? 1 : 0;
      const rightOversized = right.approximateRegion.width >= 0.8 && right.approximateRegion.height >= 0.12 ? 1 : 0;
      return leftRootArtifact - rightRootArtifact
        || leftOversized - rightOversized
        || navigationBarEvidence(result, right) - navigationBarEvidence(result, left)
        || left.approximateRegion.width * left.approximateRegion.height
          - right.approximateRegion.width * right.approximateRegion.height
        || String(left.candidateKey || '').localeCompare(String(right.candidateKey || ''));
    })[0];
    for (const duplicate of group) {
      if (duplicate === keeper) continue;
      removed.add(duplicate.candidateKey);
      replacements.set(duplicate.candidateKey, keeper.candidateKey);
    }
  }
  if (removed.size === 0) return 0;

  result.elements = elements.filter((element) => !removed.has(element.candidateKey));
  const remap = (candidateKey) => replacements.get(candidateKey) || candidateKey;
  const relationships = [];
  const relationshipKeys = new Set();
  for (const relation of result.relationships || []) {
    const remapped = {
      ...relation,
      fromCandidateKey: remap(relation.fromCandidateKey),
      toCandidateKey: remap(relation.toCandidateKey),
    };
    if (remapped.fromCandidateKey === remapped.toCandidateKey) continue;
    const key = `${remapped.fromCandidateKey}|${remapped.type}|${remapped.toCandidateKey}`;
    if (relationshipKeys.has(key)) continue;
    relationshipKeys.add(key);
    relationships.push(remapped);
  }
  result.relationships = relationships;
  result.actionCandidates = (result.actionCandidates || []).map((action) => ({
    ...action,
    triggerCandidateKey: remap(action.triggerCandidateKey),
  })).filter((action, index, actions) => actions.findIndex((candidate) => (
    candidate.triggerCandidateKey === action.triggerCandidateKey && candidate.action === action.action
  )) === index);
  return removed.size;
}

function calibrateNavigationContainerBounds(result, hierarchy = null, dom = null, coordinateViewport = null) {
  let calibrated = 0;
  for (const navigation of (result.elements || []).filter((element) => (
    element.elementType === 'navigation-bar' && element.approximateRegion
  ))) {
    const directChildren = directContainedElements(result, navigation);
    const groundedChildren = directChildren
      .filter((child) => child.approximateRegion
        && (child.riskSignals || []).includes('geometry-grounded-by-runtime'));
    const runtimeEvidence = navigationRuntimeBandEvidence(
      result,
      navigation,
      hierarchy,
      dom,
      coordinateViewport,
    );
    const evidence = runtimeEvidence?.box
      || (groundedChildren.length >= 2 ? unionBoxes(groundedChildren.map((child) => child.approximateRegion)) : null);
    if (!evidence || evidence.height > 0.18
      || (navigation.approximateRegion.height <= 0.18
        && groundedChildren.length > 0
        && groundedChildren.every((child) => boxContainsBox(navigation.approximateRegion, child.approximateRegion, 0.003)))) continue;
    const previous = navigation.approximateRegion;
    const verticalPadding = Math.max(0.002, Math.min(0.02, evidence.height * 0.2));
    // Preserve a reasonable model-provided toolbar height when it is already
    // thin; an oversized/full-page model box is the case that needs repair.
    // This keeps native tap targets comfortably inside a short toolbar while
    // allowing stale long-page bounds to collapse to the observed band.
    const evidenceHeight = evidence.height + verticalPadding * 2;
    const height = Math.min(0.18, previous.height <= 0.18
      ? Math.max(previous.height, evidenceHeight)
      : evidenceHeight);
    const left = Math.min(previous.x, evidence.x);
    const right = Math.max(previous.x + previous.width, evidence.x + evidence.width);
    navigation.approximateRegion = clampBox({
      x: left,
      y: Math.max(0, Math.min(1 - height, center(evidence).y - height / 2)),
      width: right - left,
      height,
    });
    navigation.geometryKind = 'boundary';
    navigation.geometryConfidence = Math.max(Number(navigation.geometryConfidence) || 0.5, 0.99);
    navigation.riskSignals = [...new Set([...(navigation.riskSignals || []),
      'geometry-grounded-by-runtime', 'geometry-grounded-by-structural-children',
      ...(runtimeEvidence ? ['geometry-grounded-by-navigation-band'] : []),
    ])];
    for (const child of runtimeEvidence?.elements || groundedChildren) {
      if (child.approximateRegion && boxContainsBox(navigation.approximateRegion, child.approximateRegion, 0.003)) {
        ensureContainsRelationship(result, navigation.candidateKey, child.candidateKey);
      }
    }
    calibrated += 1;
  }
  return calibrated;
}

function calibrateRepeatedListContainerBounds(result) {
  const listTypes = new Set(['list', 'grouped-list', 'swipe-list', 'expandable-list']);
  let calibrated = 0;
  for (const list of (result.elements || []).filter((element) => (
    listTypes.has(element.elementType) && element.approximateRegion
  ))) {
    // A repeated item grounded from runtime rows is the authoritative visible
    // extent of its list. Do this after hierarchy repair, because that pass
    // can otherwise preserve a stale model list rectangle by unioning it with
    // the item instead of allowing the rectangle to shrink.
    const repeatedChildren = directContainedElements(result, list).filter((child) => (
      child?.abstraction
      && ['repeated-template', 'dynamic-template'].includes(child.abstraction.kind)
      && (child.abstraction.instanceRegions || []).length >= 2
      && (child.riskSignals || []).includes('geometry-grounded-by-repeated-runtime')
    ));
    if (repeatedChildren.length === 0) continue;
    const instances = repeatedChildren.flatMap((child) => child.abstraction.instanceRegions || []).filter(Boolean);
    const evidence = unionBoxes(instances);
    if (!evidence) continue;
    const previous = list.approximateRegion;
    const changed = ['x', 'y', 'width', 'height'].some((key) => Math.abs(previous[key] - evidence[key]) > 0.000001);
    if (!changed) continue;
    list.approximateRegion = evidence;
    list.geometryKind = 'boundary';
    list.geometryConfidence = Math.max(Number(list.geometryConfidence) || 0.5, 0.99);
    list.riskSignals = [...new Set([...(list.riskSignals || []),
      'geometry-grounded-by-runtime', 'geometry-grounded-by-repeated-runtime-container'])];
    calibrated += 1;
  }
  return calibrated;
}

function directContainedElements(result, container) {
  const byKey = new Map((result.elements || []).map((element) => [element.candidateKey, element]));
  return (result.relationships || [])
    .filter((relation) => relation.type === 'contains'
      && relation.fromCandidateKey === container.candidateKey)
    .map((relation) => byKey.get(relation.toCandidateKey))
    .filter(Boolean);
}

function explicitDescendantKeys(result, containerKey) {
  const adjacency = new Map();
  for (const relation of result.relationships || []) {
    if (relation.type !== 'contains') continue;
    const children = adjacency.get(relation.fromCandidateKey) || new Set();
    children.add(relation.toCandidateKey);
    adjacency.set(relation.fromCandidateKey, children);
  }
  const descendants = new Set();
  const pending = [...(adjacency.get(containerKey) || [])];
  while (pending.length > 0) {
    const candidateKey = pending.pop();
    if (descendants.has(candidateKey) || candidateKey === containerKey) continue;
    descendants.add(candidateKey);
    for (const childKey of adjacency.get(candidateKey) || []) pending.push(childKey);
  }
  return descendants;
}

function semanticRuntimeText(nodes, terms, expectedRegion = null, exactOnly = false) {
  const normalizedTerms = terms.map((term) => normalizedText(term)).filter(Boolean);
  const maximumDistance = expectedRegion ? Math.min(0.18, Math.max(0.06, expectedRegion.height * 2.5)) : 0.18;
  return nodes.map((node) => {
    if (!node.text) return null;
    const text = normalizedText(node.text);
    const stripped = strippedStructuralPrefix(node.text);
    const exact = normalizedTerms.some((term) => text === term || stripped === term);
    const score = Math.max(0, ...normalizedTerms.map((term) => textScore(term, text)));
    const horizontalGap = expectedRegion
      ? Math.max(0, Math.max(expectedRegion.x, node.box.x)
        - Math.min(expectedRegion.x + expectedRegion.width, node.box.x + node.box.width))
      : 0;
    const proximity = expectedRegion
      ? Math.hypot(Math.abs(expectedRegion.y - node.box.y), horizontalGap)
      : 0;
    if ((!exact && (exactOnly || score < 0.78)) || proximity > maximumDistance) return null;
    return { node, exact, score, proximity };
  }).filter(Boolean).sort((left, right) => (
    Number(right.exact) - Number(left.exact)
      || right.score - left.score
      || left.proximity - right.proximity
      || left.node.box.width - right.node.box.width
  ))[0]?.node || null;
}

function medianValue(values) {
  const ordered = values.filter((value) => Number.isFinite(value)).slice().sort((left, right) => left - right);
  return ordered.length > 0 ? ordered[Math.floor(ordered.length / 2)] : 0;
}

function modelHeadingElements(elements) {
  return (elements || []).filter((element) => {
    if (!element?.approximateRegion || !String(element.label || '').trim()) return false;
    if (CONTAINER_TYPES.has(element.elementType)) {
      return !['navigation-bar', 'status-bar', 'form'].includes(element.elementType);
    }
    return ['title', 'static-label'].includes(element.elementType)
      && element.approximateRegion.width >= 0.45;
  });
}

function runtimeHeadingProfile(elements, nodes) {
  const represented = [];
  for (const element of modelHeadingElements(elements)) {
    const source = semanticRuntimeText(nodes, [element.label], element.approximateRegion, true);
    if (source) represented.push(source);
  }
  const unique = represented.filter((source, index, all) => all.findIndex((candidate) => (
    candidate === source || (normalizedText(candidate.text) === normalizedText(source.text)
      && normalizedBoxOverlap(candidate.box, source.box) >= 0.65)
  )) === index);
  return {
    nodes: unique,
    height: medianValue(unique.map((source) => source.box.height)),
    width: medianValue(unique.map((source) => source.box.width)),
    x: medianValue(unique.map((source) => source.box.x)),
  };
}

function runtimeHeadingIsRepresented(elements, source) {
  const text = normalizedText(source.text);
  if (!text) return true;
  return (elements || []).some((element) => {
    if (!element?.approximateRegion || !String(element.label || '').trim()) return false;
    const structuralContainer = CONTAINER_TYPES.has(element.elementType)
      && !['form', 'navigation-bar', 'status-bar'].includes(element.elementType);
    const eligible = structuralContainer || ['title', 'static-label'].includes(element.elementType);
    // A previous refinement pass may have appended a wide runtime text node
    // as a plain static-label. It is evidence for a structural heading, not
    // proof that the semantic section was represented. Let recovery promote
    // that node into a section so persisted/interrupted results converge with
    // fresh results.
    const syntheticRuntimeLabel = element.candidateKey?.startsWith('runtime_')
      && (element.riskSignals || []).includes('runtime-element-supplemented')
      && element.elementType === 'static-label';
    if (syntheticRuntimeLabel) return false;
    if (!eligible) return false;
    const score = textScore(element.label, source.text);
    if (score < 0.9) return false;
    // A title/label candidate accounts for the visible heading only. It is
    // sufficient to mark the section as represented when a semantic
    // container actually encloses that heading; an outer form alone is not a
    // substitute for a missing section. This lets recovery converge when a
    // retry reports the heading but omits its structural owner.
    if (!structuralContainer) {
      const headingCenter = center(source.box);
      const hasSemanticOwner = (elements || []).some((candidate) => (
        candidate !== element
          && CONTAINER_TYPES.has(candidate.elementType)
          && !['form', 'navigation-bar', 'status-bar'].includes(candidate.elementType)
          && candidate.approximateRegion
          && containsPoint(candidate.approximateRegion, headingCenter, 0.003)
      ));
      if (!hasSemanticOwner) return false;
    }
    const distanceY = Math.abs(center(element.approximateRegion).y - center(source.box).y);
    return distanceY <= Math.max(0.035, source.box.height * 3)
      && (normalizedBoxOverlap(element.approximateRegion, source.box) >= 0.15
        || Math.abs(element.approximateRegion.x - source.box.x) <= 0.08);
  });
}

function runtimeStructuralHeadingCandidates(elements, nodes) {
  const profile = runtimeHeadingProfile(elements, nodes);
  const knownHeadingHeight = profile.height || medianValue(nodes
    .filter((node) => node.text && !node.interactive)
    .map((node) => node.box.height));
  const knownHeadingWidth = profile.width || 0.55;
  const knownHeadingX = profile.nodes.length > 0 ? profile.x : null;
  const minHeight = knownHeadingHeight > 0 ? knownHeadingHeight * 0.72 : 0.006;
  const maxHeight = knownHeadingHeight > 0 ? knownHeadingHeight * 1.8 : 0.06;
  return nodes.filter((node) => {
    if (!node?.box || !String(node.text || '').trim() || node.interactive || node.editable) return false;
    if (/edittext|textarea|textbox|input|searchbox/i.test(String(node.className || ''))) return false;
    const height = node.box.height;
    const width = node.box.width;
    const classHint = /heading|title|header|section|^h[1-6]\b/i.test(String(node.className || ''));
    const lowerHeight = classHint ? minHeight * 0.7 : minHeight;
    if (height < lowerHeight || height > maxHeight) return false;
    if (width < Math.max(0.45, knownHeadingWidth * 0.55)) return false;
    if (knownHeadingX !== null && Math.abs(node.box.x - knownHeadingX) > 0.08) return false;
    return !runtimeHeadingIsRepresented(elements, node);
  }).sort((left, right) => left.box.y - right.box.y || left.box.x - right.box.x);
}

function runtimeHeadingSupportElements(result, source, nextY) {
  const elements = result.elements || [];
  const upper = Number.isFinite(nextY) ? nextY : 1;
  return elements.filter((element) => {
    if (!element?.approximateRegion || CONTAINER_TYPES.has(element.elementType)) return false;
    const region = element.approximateRegion;
    const point = center(region);
    if (point.y < source.box.y + source.box.height * 0.35 - 0.003 || point.y >= upper - 0.001) return false;
    const horizontal = horizontalOverlapRatio(source.box, region);
    if (horizontal < 0.12 && !containsPoint(source.box, point, 0.08)) return false;
    // A missing section needs observable payload, not just a caption or a
    // second heading. Dynamic templates and controls are the strongest
    // evidence; ordinary labels are accepted when no stronger type exists.
    return element.dynamicContent === true
      || element.interactive
      || INPUT_TYPES.has(element.elementType)
      || !['caption', 'title', 'breadcrumb', 'status'].includes(element.elementType);
  });
}

function runtimeHeadingSupportNodes(nodes, source, nextY) {
  const upper = Number.isFinite(nextY) ? nextY : 1;
  return nodes.filter((node) => {
    if (!node?.box || node === source || (!node.interactive && !/image|img|button/i.test(String(node.className || '')))) return false;
    const point = center(node.box);
    return point.y >= source.box.y + source.box.height * 0.35 - 0.003
      && point.y < upper - 0.001
      && (horizontalOverlapRatio(source.box, node.box) >= 0.12 || containsPoint(source.box, point, 0.08));
  });
}

function stableRuntimeSectionKey(source, index, existingKeys = new Set()) {
  const base = stableRuntimeKey({
    ...source,
    text: `section:${source.text || ''}`,
  }, index).replace(/^runtime_/u, 'runtime_section_');
  let key = base;
  let suffix = 1;
  while (existingKeys.has(key)) key = `${base}_${suffix++}`;
  return key;
}

function isSyntheticRuntimeHeading(element) {
  return Boolean(element?.candidateKey?.startsWith('runtime_')
    && element.elementType === 'static-label'
    && (element.riskSignals || []).includes('runtime-element-supplemented')
    && String(element.label || '').trim());
}

function matchingSyntheticRuntimeHeading(elements, source) {
  return (elements || [])
    .filter((element) => isSyntheticRuntimeHeading(element)
      && textScore(element.label, source?.text) >= 0.9
      && element.approximateRegion
      && (normalizedBoxOverlap(element.approximateRegion, source.box) >= 0.15
        || Math.abs(element.approximateRegion.x - source.box.x) <= 0.08))
    .sort((left, right) => (
      Math.abs(center(left.approximateRegion).y - center(source.box).y)
        - Math.abs(center(right.approximateRegion).y - center(source.box).y)
    ))[0] || null;
}

// A runtime-only heading can already exist in a persisted/interrupted result
// as a plain label.  The supplement pass may have attached that label to any
// overlapping section (and sometimes to several of them).  Once the label is
// promoted to a semantic section those edges become stale: sibling ordering
// then treats the new section as nested in the previous section and its bounds
// can consume the following region.  Keep only the outer structural owners;
// the recovered section itself will be reattached to its concrete payload.
function removeStaleRuntimeHeadingParents(result, headingKey) {
  const elements = result.elements || [];
  const byKey = new Map(elements.map((element) => [element.candidateKey, element]));
  const outerTypes = new Set([
    'form', 'list', 'grouped-list', 'swipe-list', 'expandable-list', 'table',
  ]);
  result.relationships = (result.relationships || []).filter((relation) => {
    if (relation.type !== 'contains' || relation.toCandidateKey !== headingKey) return true;
    const parent = byKey.get(relation.fromCandidateKey);
    if (!parent || !CONTAINER_TYPES.has(parent.elementType)) return true;
    return outerTypes.has(parent.elementType);
  });
}

function recoverMissingSemanticContainers(result, hierarchy, dom, coordinateViewport) {
  const elements = result.elements || (result.elements = []);
  const nodes = runtimeSemanticNodes(hierarchy, dom, coordinateViewport);
  if (nodes.length === 0) return 0;
  const forms = elements.filter((element) => element.elementType === 'form' && element.approximateRegion);
  // Establish the common form owner before sibling ordering. Interrupted
  // model output often has no relationships at all, while the section boxes
  // themselves still provide enough evidence to recover that parent.
  for (const section of elements.filter((element) => (
    CONTAINER_TYPES.has(element.elementType)
      && !['form', 'navigation-bar', 'status-bar'].includes(element.elementType)
      && element.approximateRegion
  ))) {
    const hasContainerParent = (result.relationships || []).some((relation) => (
      relation.type === 'contains'
        && relation.toCandidateKey === section.candidateKey
        && elements.some((parent) => parent.candidateKey === relation.fromCandidateKey
          && CONTAINER_TYPES.has(parent.elementType))
    ));
    if (hasContainerParent) continue;
    const parent = forms
      .filter((candidate) => containsPoint(candidate.approximateRegion, center(section.approximateRegion), 0.01))
      .sort((left, right) => (
        left.approximateRegion.width * left.approximateRegion.height
          - right.approximateRegion.width * right.approximateRegion.height
      ))[0];
    if (parent) ensureContainsRelationship(result, parent.candidateKey, section.candidateKey);
  }
  const missingHeadingCandidates = runtimeStructuralHeadingCandidates(elements, nodes);
  if (missingHeadingCandidates.length === 0) return 0;
  const knownHeadingNodes = runtimeHeadingProfile(elements, nodes).nodes;
  const allHeadingCandidates = [...knownHeadingNodes, ...missingHeadingCandidates]
    .filter((source, index, all) => all.findIndex((candidate) => (
      candidate === source || (normalizedText(candidate.text) === normalizedText(source.text)
        && normalizedBoxOverlap(candidate.box, source.box) >= 0.65)
    )) === index)
    .sort((left, right) => left.box.y - right.box.y || left.box.x - right.box.x);
  const existingKeys = new Set(elements.map((element) => element.candidateKey));
  const recovered = [];
  let index = 0;
  for (const source of missingHeadingCandidates) {
    if (runtimeHeadingIsRepresented(elements, source)
      || recovered.some((candidate) => normalizedText(candidate.label) === normalizedText(source.text))) continue;
    const nextHeading = allHeadingCandidates.find((candidate) => candidate.box.y > source.box.y + 0.001);
    const nextY = nextHeading?.box.y;
    const previousHeading = allHeadingCandidates.slice().reverse().find((candidate) => candidate.box.y < source.box.y - 0.001);
    const minimumGap = Math.max(0.012, source.box.height * 1.35);
    if (previousHeading && source.box.y - (previousHeading.box.y + previousHeading.box.height) < minimumGap) continue;
    if (nextHeading && nextHeading.box.y - (source.box.y + source.box.height) < minimumGap) continue;

    const supportElements = runtimeHeadingSupportElements(result, source, nextY);
    const supportNodes = runtimeHeadingSupportNodes(nodes, source, nextY);
    // Runtime-only descendants are useful when a model interruption omitted
    // the whole section. Require either a concrete model payload or multiple
    // independent interactive/visual nodes so captions cannot become sections.
    if (supportElements.length === 0 && supportNodes.length < 2) continue;

    const form = forms
      .filter((candidate) => containsPoint(candidate.approximateRegion, center(source.box), 0.02))
      .sort((left, right) => (
        left.approximateRegion.width * left.approximateRegion.height
          - right.approximateRegion.width * right.approximateRegion.height
      ))[0] || null;
    const siblingContainer = elements
      .filter((element) => CONTAINER_TYPES.has(element.elementType)
        && !['navigation-bar', 'status-bar', 'form'].includes(element.elementType)
        && element.approximateRegion
        && Math.abs(element.approximateRegion.x - source.box.x) <= 0.08
        && horizontalOverlapRatio(element.approximateRegion, source.box) >= 0.3)
      .sort((left, right) => Math.abs(center(left.approximateRegion).y - center(source.box).y)
        - Math.abs(center(right.approximateRegion).y - center(source.box).y))[0] || null;
    // A heading already inside a well-bounded existing section is normally a
    // child title, not evidence of a missing sibling. Permit a split only
    // when the candidate has payload beyond the existing section's title and
    // reaches the section's lower half.
    if (siblingContainer && boxContainsBox(siblingContainer.approximateRegion, source.box, 0.002)) {
      const siblingTitle = semanticRuntimeText(nodes, [siblingContainer.label], siblingContainer.approximateRegion, true);
      const titleGap = siblingTitle ? source.box.y - (siblingTitle.box.y + siblingTitle.box.height) : 0;
      if (!supportElements.some((element) => element.approximateRegion.y >= source.box.y)
        || (siblingTitle && titleGap < minimumGap)) continue;
    }

    const upper = nextY ?? Math.min(1, Math.max(
      source.box.y + source.box.height,
      ...supportElements.map((element) => element.approximateRegion.y + element.approximateRegion.height),
      ...supportNodes.map((node) => node.box.y + node.box.height),
    ) + Math.max(0.004, source.box.height * 0.35));
    const sectionBox = clampBox({
      x: source.box.x,
      y: source.box.y,
      width: source.box.width,
      height: Math.max(0.001, upper - source.box.y),
    });
    const syntheticHeading = matchingSyntheticRuntimeHeading(elements, source);
    const candidateKey = syntheticHeading?.candidateKey
      || stableRuntimeSectionKey(source, index++, existingKeys);
    existingKeys.add(candidateKey);
    const section = syntheticHeading || {
      candidateKey,
      label: String(source.text).trim(),
      visualDescription: '由运行时同级标题和可见内容恢复的页面区域。',
      displayCondition: '截图中可见时显示',
      elementType: 'section',
      interactive: false,
      enabled: true,
      state: null,
      approximateRegion: sectionBox,
      geometryKind: 'boundary',
      geometryConfidence: 0.99,
      meaning: {
        status: 'known',
        description: '运行时结构中可见标题及其相邻内容组成的区域。',
        evidence: {
          visibleTexts: [String(source.text).trim()],
          visibleIcons: [],
          visibleStates: [],
          visualCues: ['运行时同级标题', '标题下方存在可见内容'],
          userContext: null,
          unclassified: [],
        },
      },
      dynamicContent: false,
      abstraction: null,
      riskSignals: ['geometry-grounded-by-runtime', 'runtime-section-recovered'],
      confidence: 0.9,
    };
    // Reusing a synthetic heading keeps candidate/action references stable
    // when an interrupted recognition is refined a second time.
    if (syntheticHeading) {
      removeStaleRuntimeHeadingParents(result, syntheticHeading.candidateKey);
      section.label = String(source.text).trim();
      section.visualDescription = '由运行时同级标题和可见内容恢复的页面区域。';
      section.elementType = 'section';
      section.interactive = false;
      section.enabled = true;
      section.state = null;
      section.approximateRegion = sectionBox;
      section.geometryKind = 'boundary';
      section.geometryConfidence = Math.max(Number(section.geometryConfidence) || 0.5, 0.99);
      section.dynamicContent = false;
      section.abstraction = null;
      section.meaning = {
        status: 'known',
        description: '运行时结构中可见标题及其相邻内容组成的区域。',
        evidence: {
          visibleTexts: [String(source.text).trim()],
          visibleIcons: [],
          visibleStates: [],
          visualCues: ['运行时同级标题', '标题下方存在可见内容'],
          userContext: null,
          unclassified: [],
        },
      };
      section.riskSignals = [...new Set([...(section.riskSignals || []), 'geometry-grounded-by-runtime', 'runtime-section-recovered'])];
      section.confidence = Math.max(Number(section.confidence) || 0.5, 0.9);
    } else {
      elements.push(section);
    }
    recovered.push(section);
    if (form) ensureContainsRelationship(result, form.candidateKey, candidateKey);

    const payload = supportElements.filter((element) => (
      element.approximateRegion.y >= source.box.y + source.box.height * 0.35 - 0.003
      && (!nextY || element.approximateRegion.y < nextY - 0.001)
    ));
    for (const child of payload) {
      // A child may have been attached to the preceding section while the
      // model was interrupted. Move only structural-container ownership; keep
      // the outer form/list relationship for transitive pruning later.
      result.relationships = (result.relationships || []).filter((relation) => {
        if (relation.type !== 'contains' || relation.toCandidateKey !== child.candidateKey
          || relation.fromCandidateKey === candidateKey) return true;
        const owner = elements.find((element) => element.candidateKey === relation.fromCandidateKey);
        if (!owner || owner.elementType === 'form' || owner.elementType === 'list') return true;
        return !(owner.approximateRegion
          && owner.approximateRegion.y < source.box.y + source.box.height
          && center(child.approximateRegion).y >= source.box.y);
      });
      ensureContainsRelationship(result, candidateKey, child.candidateKey);
    }
  }
  return recovered.length;
}

function calibrateSemanticContainerBounds(result, hierarchy, dom, coordinateViewport) {
  const elements = result.elements || [];
  const nodes = runtimeSemanticNodes(hierarchy, dom, coordinateViewport);
  let calibrated = calibrateNavigationContainerBounds(result, hierarchy, dom, coordinateViewport);
  // In a stitched full-page screenshot the model's container rectangle is
  // measured against the actual long image. Rebuilding it from runtime text
  // anchors changes an outer visual boundary into a title-to-last-child span
  // (for example, a settings panel starts below its heading). Keep the
  // screenshot-measured boundary and reserve this heuristic for viewport
  // captures where it is needed to recover an incomplete section.
  if (isFullPageScreenshot(hierarchy, coordinateViewport)) return calibrated;
  if (nodes.length === 0) return calibrated;
  const sections = elements
    .filter((element) => CONTAINER_TYPES.has(element.elementType)
      && !['navigation-bar', 'status-bar', 'form'].includes(element.elementType)
      && element.approximateRegion && String(element.label || '').trim())
    .sort((left, right) => left.approximateRegion.y - right.approximateRegion.y)
    .map((element, index, all) => ({
      element,
      title: [element.label],
      next: all.slice(index + 1).filter((candidate) => sameContainerLevel(result, element, candidate)
        && horizontalOverlapRatio(element.approximateRegion, candidate.approximateRegion) >= 0.3),
    }));
  for (const section of sections) {
    if (!section.element?.approximateRegion) continue;
    const previous = section.element.approximateRegion;
    const title = semanticRuntimeText(nodes, section.title, previous, true);
    if (!title) continue;
    if (Math.abs(title.box.y - previous.y) > Math.min(0.18, Math.max(0.06, previous.height * 2.5))) continue;
    const nextContainerTitles = section.next.length > 0 ? section.next
      .map((candidate) => semanticRuntimeText(nodes, [candidate.label], candidate.approximateRegion, true))
      .filter(Boolean)
      .filter((candidate) => candidate.box.y > title.box.y + 0.001)
      : [];
    const nextStandaloneHeadings = elements
      .filter((candidate) => candidate !== section.element
        && ['title', 'subtitle', 'static-label'].includes(candidate.elementType)
        && candidate.approximateRegion
        && sameContainerLevel(result, section.element, candidate)
        && candidate.approximateRegion.y > previous.y + 0.005
        && candidate.approximateRegion.width >= previous.width * 0.65)
      .map((candidate) => semanticRuntimeText(nodes, [candidate.label], candidate.approximateRegion, true))
      .filter((candidate) => candidate?.box.y > title.box.y + 0.001
        && candidate.box.height >= title.box.height * 0.7);
    const next = [...nextContainerTitles, ...nextStandaloneHeadings]
      .sort((left, right) => left.box.y - right.box.y)[0] || null;
    const lower = title.box.y;
    const previousBottom = previous.y + previous.height;
    const upper = next?.box.y
      ?? Math.min(1, Math.max(previousBottom, title.box.y + title.box.height) + Math.max(0.01, previous.height * 0.25));
    const children = nodes.filter((node) => node.box.y >= lower - 0.001
      && node.box.y < upper - 0.001
      && node.box.y + node.box.height <= upper + 0.003
      && (node.text || node.interactive)
      && center(node.box).x >= previous.x - 0.02
      && center(node.box).x <= previous.x + previous.width + 0.02);
    const explicitChildren = directContainedElements(result, section.element).filter((child) => (
      child.approximateRegion
        && child.approximateRegion.y + child.approximateRegion.height > lower - 0.003
        && child.approximateRegion.y < upper - 0.001
        && child.approximateRegion.y + child.approximateRegion.height <= upper + 0.003
        && center(child.approximateRegion).x >= previous.x - 0.02
        && center(child.approximateRegion).x <= previous.x + previous.width + 0.02
        && boxContainsBox(previous, child.approximateRegion, 0.003)
        // A stale dynamic outer box may cross into the next section. Do not
        // let it extend this boundary unless its stable fields substantially
        // support this section; runtime nodes below still provide the visible
        // evidence for a genuinely empty/partially clipped payload.
        && (!child.dynamicContent || !child.abstraction
          || dynamicChildHasStrongOwnerEvidence(section.element, child))
    ));
    const observedBottom = Math.max(
      title.box.y + title.box.height,
      ...children.map((node) => node.box.y + node.box.height),
      ...explicitChildren.map((child) => child.approximateRegion.y + child.approximateRegion.height),
    );
    const bottom = Math.min(upper, children.length > 1 || explicitChildren.length > 0
      ? observedBottom
      : Math.min(previousBottom, upper));
    if (!(bottom > title.box.y)) continue;
    section.element.approximateRegion = clampBox({
      ...previous,
      y: title.box.y,
      height: bottom - title.box.y,
    });
    section.element.geometryKind = 'boundary';
    section.element.geometryConfidence = Math.max(Number(section.element.geometryConfidence) || 0.5, 0.99);
    section.element.riskSignals = [...new Set([...(section.element.riskSignals || []), 'geometry-grounded-by-runtime', 'geometry-grounded-by-semantic-container'])];
    calibrated += 1;
  }
  return calibrated;
}

function calibrateFormContainerBounds(result, hierarchy, dom, coordinateViewport) {
  const elements = result.elements || [];
  const forms = elements.filter((element) => (
    element.elementType === 'form' && element.approximateRegion
  )).sort((left, right) => left.approximateRegion.y - right.approximateRegion.y);
  if (forms.length === 0) return 0;
  const nodes = runtimeSemanticNodes(hierarchy, dom, coordinateViewport);
  if (nodes.length === 0) return 0;
  let calibrated = 0;
  for (const form of forms) {
    const start = form.approximateRegion.y;
    const upper = forms
      .filter((candidate) => candidate !== form
        && sameContainerLevel(result, form, candidate)
        && horizontalOverlapRatio(form.approximateRegion, candidate.approximateRegion) >= 0.3
        && candidate.approximateRegion.y > start + 0.001)
      .map((candidate) => candidate.approximateRegion.y)
      .sort((left, right) => left - right)[0] ?? 1;
    const runtimeChildren = nodes.filter((node) => {
      if (!node.box || node.box.y + node.box.height <= start + 0.001) return false;
      if (node.box.y >= upper - 0.001 || node.box.y + node.box.height > upper + 0.003) return false;
      if (center(node.box).x < form.approximateRegion.x - 0.02
        || center(node.box).x > form.approximateRegion.x + form.approximateRegion.width + 0.02) return false;
      // Do not use a full-screen WebView/ancestor as an internal form bound.
      // Its descendants still provide the visible lower edge.
      const area = node.box.width * node.box.height;
      return area < 0.9 || node.box.height < 0.75;
    });
    const descendantKeys = explicitDescendantKeys(result, form.candidateKey);
    const explicitChildren = elements.filter((element) => descendantKeys.has(element.candidateKey)
      && element.approximateRegion
      && element.approximateRegion.y + element.approximateRegion.height > start + 0.001
      && element.approximateRegion.y < upper - 0.001
      && element.approximateRegion.y + element.approximateRegion.height <= upper + 0.003
      && center(element.approximateRegion).x >= form.approximateRegion.x - 0.02
      && center(element.approximateRegion).x <= form.approximateRegion.x + form.approximateRegion.width + 0.02);
    const runtimeBottom = Math.max(
      0,
      ...runtimeChildren.map((node) => node.box.y + node.box.height),
      ...explicitChildren.map((element) => element.approximateRegion.y + element.approximateRegion.height),
    );
    if (!(runtimeBottom > start + 0.001)) continue;
    const currentBottom = start + form.approximateRegion.height;
    if (runtimeBottom <= currentBottom + 0.01) continue;
    form.approximateRegion = clampBox({
      ...form.approximateRegion,
      height: Math.min(runtimeBottom, upper) - start,
    });
    form.geometryKind = 'boundary';
    form.geometryConfidence = Math.max(Number(form.geometryConfidence) || 0.5, 0.99);
    form.riskSignals = [...new Set([...(form.riskSignals || []), 'geometry-grounded-by-runtime', 'geometry-grounded-by-semantic-form'])];
    calibrated += 1;
  }
  return calibrated;
}

function removeSyntheticContainerLabelDuplicates(result) {
  const elements = result.elements || [];
  const containers = elements.filter((element) => CONTAINER_TYPES.has(element.elementType) && element.label && element.approximateRegion);
  const removed = new Set(elements.filter((element) => (
    element.candidateKey?.startsWith('runtime_')
      && !CONTAINER_TYPES.has(element.elementType)
      && element.label
      && containers.some((container) => normalizedText(container.label) === normalizedText(element.label)
        && containsPoint(container.approximateRegion, center(element.approximateRegion), 0.003))
  )).map((element) => element.candidateKey));
  if (removed.size === 0) return 0;
  result.elements = elements.filter((element) => !removed.has(element.candidateKey));
  result.relationships = (result.relationships || []).filter((relation) => (
    !removed.has(relation.fromCandidateKey) && !removed.has(relation.toCandidateKey)
  ));
  result.actionCandidates = (result.actionCandidates || []).filter((action) => !removed.has(action.triggerCandidateKey));
  return removed.size;
}

function removeContainerRelations(result, containerKey, predicate) {
  result.relationships = (result.relationships || []).filter((relation) => !(
    relation.fromCandidateKey === containerKey
      && relation.type === 'contains'
      && predicate(relation.toCandidateKey)
  ));
}

function nextStructuralBoundary(result, container) {
  if (!container?.approximateRegion) return null;
  const start = container.approximateRegion.y + 0.005;
  const candidates = (result.elements || [])
    .filter((candidate) => {
      if (!candidate || candidate === container || !candidate.approximateRegion) return false;
      const region = candidate.approximateRegion;
      if (region.y <= start || horizontalOverlapRatio(container.approximateRegion, region) < 0.3) return false;
      // A nested structural section is part of this container's content; it
      // is not a sibling boundary for a dynamic child owned by the outer
      // container. Runtime-supplemented wide labels have no containment edge
      // yet and intentionally remain eligible as sibling boundaries.
      if (CONTAINER_TYPES.has(candidate.elementType)
        && containsPath(result, container.candidateKey, candidate.candidateKey)) return false;
      if (CONTAINER_TYPES.has(candidate.elementType)) return true;
      return ['title', 'static-label'].includes(candidate.elementType)
        && region.width >= container.approximateRegion.width * 0.65;
    })
    .sort((left, right) => left.approximateRegion.y - right.approximateRegion.y);
  return candidates[0]?.approximateRegion.y ?? null;
}

function childRegionForContainer(result, container, child) {
  const region = child?.approximateRegion;
  const ownerRegion = container?.approximateRegion;
  if (!region || !ownerRegion) return null;

  // Dynamic payloads are occasionally serialized with an outer rectangle
  // spanning the next sibling section.  The field slots are the stable part
  // of that payload, so use the slots that actually belong to this container
  // when deciding whether the container should expand.  Keep a fully enclosed
  // outer rectangle intact to preserve useful row padding; only discard the
  // stale overflow, never mutate the child here.
  if (child.dynamicContent === true && child.abstraction?.kind === 'dynamic-template') {
    if (boxContainsBox(ownerRegion, region, 0.003)) return region;
    const siblingBoundary = nextStructuralBoundary(result, container);
    const fieldRegions = (child.abstraction.fields || [])
      .flatMap((field) => (field.instanceRegions || []).filter(Boolean))
      .filter((fieldRegion) => {
        if (Number.isFinite(siblingBoundary)
          && fieldRegion.y >= siblingBoundary - 0.001) return false;
        const overlapWidth = Math.max(0, Math.min(ownerRegion.x + ownerRegion.width, fieldRegion.x + fieldRegion.width)
          - Math.max(ownerRegion.x, fieldRegion.x));
        const overlapHeight = Math.max(0, Math.min(ownerRegion.y + ownerRegion.height, fieldRegion.y + fieldRegion.height)
          - Math.max(ownerRegion.y, fieldRegion.y));
        const coverage = overlapWidth * overlapHeight
          / Math.max(0.000001, fieldRegion.width * fieldRegion.height);
        return coverage >= 0.5
          || (overlapWidth > 0 && overlapHeight > 0
            && containsPoint(ownerRegion, center(fieldRegion), 0.002));
      });
    return unionBoxes(fieldRegions);
  }

  // The old 1% normalized tolerance becomes dozens of pixels on a stitched
  // full-page screenshot. A small, scale-independent tolerance is enough for
  // rounding drift while preventing a neighbouring row from being pulled in.
  return containsPoint(ownerRegion, center(region), 0.003) ? region : null;
}

function ensureContainerChildren(result, container, explicitChildren = [], excludedKeys = new Set(), preserveBoundary = false) {
  if (!container?.approximateRegion) return;
  const children = new Map();
  const childRegions = new Map();
  for (const child of explicitChildren) {
    const effectiveRegion = childRegionForContainer(result, container, child);
    if (!effectiveRegion) continue;
    if (child.dynamicContent === true && child.abstraction?.kind === 'dynamic-template'
      && dynamicOwnerForChild(result, child) !== container) continue;
    children.set(child.candidateKey, child);
    childRegions.set(child.candidateKey, effectiveRegion);
  }
  for (const element of result.elements || []) {
    if (element === container || excludedKeys.has(element.candidateKey) || !element.approximateRegion) continue;
    // A section must never contain an ancestor form or another structural
    // container merely because their centers overlap near a short row.
    if (CONTAINER_TYPES.has(element.elementType)) continue;
    if (element.dynamicContent === true && element.abstraction?.kind === 'dynamic-template'
      && dynamicOwnerForChild(result, element) !== container) continue;
    const effectiveRegion = childRegionForContainer(result, container, element);
    if (effectiveRegion) {
      children.set(element.candidateKey, element);
      childRegions.set(element.candidateKey, effectiveRegion);
    }
  }
  if (!preserveBoundary) {
    expandContainerToChildren(container, [...children.entries()].map(([key, child]) => ({
      ...child,
      approximateRegion: childRegions.get(key),
    })));
  }
  for (const child of children.values()) ensureContainsRelationship(result, container.candidateKey, child.candidateKey);
}

function pruneTransitiveContainment(result) {
  const relationships = result.relationships || [];
  const contains = relationships.filter((relation) => relation.type === 'contains');
  if (contains.length < 2) return;
  const adjacency = new Map();
  for (const relation of contains) {
    const next = adjacency.get(relation.fromCandidateKey) || new Set();
    next.add(relation.toCandidateKey);
    adjacency.set(relation.fromCandidateKey, next);
  }
  const transitive = new Set();
  for (const relation of contains) {
    const pending = [...(adjacency.get(relation.fromCandidateKey) || [])]
      .filter((candidateKey) => candidateKey !== relation.toCandidateKey);
    const visited = new Set();
    while (pending.length > 0) {
      const current = pending.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      if (current === relation.toCandidateKey) {
        transitive.add(relation);
        break;
      }
      for (const next of adjacency.get(current) || []) {
        if (!visited.has(next)) pending.push(next);
      }
    }
  }
  if (transitive.size > 0) result.relationships = relationships.filter((relation) => !transitive.has(relation));
}

function pruneOutOfBoundsContainment(result) {
  const byKey = new Map((result.elements || []).map((element) => [element.candidateKey, element]));
  result.relationships = (result.relationships || []).filter((relation) => {
    if (relation.type !== 'contains') return true;
    const owner = byKey.get(relation.fromCandidateKey);
    const child = byKey.get(relation.toCandidateKey);
    if (!owner?.approximateRegion || !child?.approximateRegion) return true;
    // A containment edge is a geometric assertion. Drop stale model edges
    // once authoritative runtime bounds show the child outside its owner;
    // this is independent of labels, candidate-key naming, or hierarchy
    // depth and prevents an earlier approximation from surviving calibration.
    const ownerRegion = owner.approximateRegion;
    const childRegion = child.approximateRegion;
    // Runtime title rows can start a couple of pixels above the section
    // boundary after full-page stitching. Keep that small measurement drift
    // while still rejecting genuinely cross-section children.
    const tolerance = 0.003;
    return childRegion.x >= ownerRegion.x - tolerance
      && childRegion.y >= ownerRegion.y - tolerance
      && childRegion.x + childRegion.width <= ownerRegion.x + ownerRegion.width + tolerance
      && childRegion.y + childRegion.height <= ownerRegion.y + ownerRegion.height + tolerance;
  });
}

function pruneDanglingRelationships(result) {
  const keys = new Set((result.elements || []).map((element) => element.candidateKey));
  result.relationships = (result.relationships || []).filter((relation) => (
    keys.has(relation.fromCandidateKey) && keys.has(relation.toCandidateKey)
  ));
}

function expandContainerToChildren(container, children) {
  if (!container?.approximateRegion) return;
  const boxes = [container.approximateRegion, ...children.map((child) => child?.approximateRegion).filter(Boolean)];
  const expanded = unionBoxes(boxes);
  if (expanded) {
    // Keep the model's boundary when possible, but include visible child rows
    // that slightly exceed stale model bounds (common for attachment help).
    container.approximateRegion = clampBox({
      x: Math.min(container.approximateRegion.x, expanded.x),
      y: Math.min(container.approximateRegion.y, expanded.y),
      width: Math.max(container.approximateRegion.x + container.approximateRegion.width, expanded.x + expanded.width)
        - Math.min(container.approximateRegion.x, expanded.x),
      height: Math.max(container.approximateRegion.y + container.approximateRegion.height, expanded.y + expanded.height)
        - Math.min(container.approximateRegion.y, expanded.y),
    });
  }
}

function intersectBoxWithOwner(box, owner) {
  if (!box || !owner) return box;
  const left = Math.max(owner.x, box.x);
  const top = Math.max(owner.y, box.y);
  const right = Math.min(owner.x + owner.width, box.x + box.width);
  const bottom = Math.min(owner.y + owner.height, box.y + box.height);
  if (right <= left || bottom <= top) {
    // Keep a visible, recoverable marker inside the owner when a stale model
    // region is wholly outside it. Never expand the owner to accommodate it.
    return clampBox({
      x: Math.min(Math.max(box.x, owner.x), owner.x + Math.max(0, owner.width - 0.001)),
      y: Math.min(Math.max(box.y, owner.y), owner.y + Math.max(0, owner.height - 0.001)),
      width: Math.min(0.001, owner.width),
      height: Math.min(0.001, owner.height),
    });
  }
  return clampBox({ x: left, y: top, width: right - left, height: bottom - top });
}

function clipDynamicChildrenToOwners(result) {
  const elements = result.elements || [];
  let clipped = 0;
  for (const owner of elements.filter((element) => CONTAINER_TYPES.has(element.elementType) && element.approximateRegion)) {
    for (const child of dynamicChildrenOf(result, owner)) {
      const original = JSON.stringify({ approximateRegion: child.approximateRegion, abstraction: child.abstraction });
      child.approximateRegion = intersectBoxWithOwner(child.approximateRegion, owner.approximateRegion);
      if (child.abstraction) {
        child.abstraction.instanceRegions = (child.abstraction.instanceRegions || [child.approximateRegion])
          .map((region) => intersectBoxWithOwner(region, owner.approximateRegion));
        const childRegion = child.abstraction.instanceRegions[0] || child.approximateRegion;
        for (const field of child.abstraction.fields || []) {
          field.instanceRegions = (field.instanceRegions || [])
            .map((region) => intersectBoxWithOwner(region, childRegion));
        }
      }
      const current = JSON.stringify({ approximateRegion: child.approximateRegion, abstraction: child.abstraction });
      if (current !== original) {
        child.riskSignals = [...new Set([...(child.riskSignals || []), 'geometry-clipped-to-semantic-owner'])];
        clipped += 1;
      }
    }
  }
  return clipped;
}

function dynamicChildFromContainer(container, childKey) {
  const abstraction = container?.abstraction;
  if (!abstraction || abstraction.kind !== 'dynamic-template') return null;
  const field = abstraction.fields?.[0] || null;
  const region = unionBoxes([
    ...(abstraction.instanceRegions || []),
    ...(abstraction.fields || []).flatMap((candidate) => candidate.instanceRegions || []),
  ].filter(Boolean));
  if (!region) return null;
  const fields = (abstraction.fields || []).map((candidate) => ({
    ...candidate,
    parentId: childKey,
    instanceRegions: (candidate.instanceRegions || []).slice(0, 1),
  }));
  return {
    candidateKey: childKey,
    label: field?.label || container.label || null,
    visualDescription: '从结构容器拆分出的动态元素共相。',
    displayCondition: container.displayCondition || '存在已添加对象时显示',
    elementType: field?.elementType || 'section',
    interactive: false,
    enabled: true,
    state: null,
    approximateRegion: region,
    geometryKind: 'boundary',
    geometryConfidence: Math.max(Number(container.geometryConfidence) || 0.5, 0.99),
    meaning: {
      status: 'known',
      description: '容器内当前可见的动态展示槽位',
      evidence: {
        visibleTexts: field?.label ? [field.label] : [],
        visibleIcons: [],
        visibleStates: [],
        visualCues: ['位于所属结构容器内的可见字段'],
        userContext: null,
        unclassified: [],
      },
    },
    dynamicContent: true,
    abstraction: {
      ...abstraction,
      instanceCount: 1,
      fields,
      instanceRegions: [region],
      bboxStyle: 'abstract',
    },
    riskSignals: [...new Set([...(container.riskSignals || []), 'dynamic-child-split-from-container'])],
    confidence: Math.max(Number(container.confidence) || 0.5, 0.9),
  };
}

function splitDynamicContainer(result, container) {
  if (!container) return null;
  const existing = dynamicChildrenOf(result, container)[0];
  if (container.abstraction?.kind === 'dynamic-template') {
    const fieldKey = container.abstraction.fields?.[0]?.key;
    const childKey = existing?.candidateKey || (fieldKey ? `${fieldKey}_item` : `${container.candidateKey}_dynamic`);
    const child = existing || dynamicChildFromContainer(container, childKey);
    if (child && !existing) result.elements.push(child);
    if (child) {
      child.abstraction ||= dynamicChildFromContainer(container, childKey)?.abstraction;
      if (child.abstraction) {
        child.abstraction.instanceCount = 1;
        child.abstraction.fields = (child.abstraction.fields || []).map((field) => ({ ...field, parentId: childKey }));
      }
      child.dynamicContent = true;
      ensureContainsRelationship(result, container.candidateKey, child.candidateKey);
    }
    container.abstraction = null;
    container.dynamicContent = false;
    return child;
  }
  return existing;
}

function ensureSemanticHierarchy(result, { preserveContainerGeometry = false } = {}) {
  const elements = result.elements || [];
  for (const container of elements.filter((element) => CONTAINER_TYPES.has(element.elementType) && element.approximateRegion)) {
    const dynamicChild = splitDynamicContainer(result, container);
    const explicit = dynamicChild ? [dynamicChild] : dynamicChildrenOf(result, container);
    ensureContainerChildren(result, container, explicit, new Set(), preserveContainerGeometry);
  }
}

function mergeAnchorSources(sources) {
  const merged = [];
  for (const source of [...sources].sort((left, right) => right.confidence - left.confidence)) {
    const sourceTextKey = normalizedText(source.text);
    let duplicateIndex = -1;
    merged.forEach((candidate, index) => {
      if (sourceTextKey
        && normalizedText(candidate.text) === sourceTextKey
        // Only overlapping rectangles can be two observations of one line.
        // Distance-only deduplication merges dense repeated rows that happen
        // to share the same value.
        && normalizedBoxOverlap(candidate.box, source.box) >= 0.5) {
        duplicateIndex = index;
      }
    });
    if (duplicateIndex < 0) {
      merged.push(source);
    } else {
      merged[duplicateIndex] = preferredTextGeometry(merged[duplicateIndex], source);
    }
  }
  return merged;
}

function ocrSources(ocr, screenshot, minimumTextLength = 2) {
  const width = ocr?.width || screenshot?.width;
  const height = ocr?.height || screenshot?.height;
  return (ocr?.observations || []).map((observation) => ({
    text: observation.text,
    confidence: Number(observation.confidence) || 0,
    box: normalizedScreenshotRect(observation.rect, width, height),
    fragments: (observation.fragments || []).map((fragment) => ({
      text: fragment.text,
      start: Number.isFinite(Number(fragment.start)) ? Number(fragment.start) : null,
      end: Number.isFinite(Number(fragment.end)) ? Number(fragment.end) : null,
      box: normalizedScreenshotRect(fragment.rect, width, height),
    })).filter((fragment) => fragment.text && fragment.box),
  })).filter((item) => item.box && item.confidence >= 0.3 && normalizedText(item.text).length >= minimumTextLength);
}

function visionRectangleSources(ocr, screenshot) {
  const width = ocr?.width || screenshot?.width;
  const height = ocr?.height || screenshot?.height;
  return (ocr?.rectangles || []).map((observation) => ({
    confidence: Number(observation.confidence) || 0,
    box: normalizedScreenshotRect(observation.rect, width, height),
  })).filter((item) => item.box
    && item.confidence >= 0.3
    && item.box.width >= 0.2
    && item.box.height >= 0.04);
}

function containsPoint(box, point, tolerance = 0.005) {
  return point.x >= box.x - tolerance
    && point.x <= box.x + box.width + tolerance
    && point.y >= box.y - tolerance
    && point.y <= box.y + box.height + tolerance;
}

function calibratedVisionRectangleSources(rectangles) {
  // Vision can report both an outer border and an inner edge for one control.
  // Keep the largest rectangle for that local region, but never transfer its
  // inset to another control. Controls may legitimately have different sizes
  // or border radii, and cross-instance extrapolation is the source of the
  // accumulating vertical and horizontal drift seen in long WebViews.
  const ordered = [...rectangles].sort((left, right) => (
    right.box.width * right.box.height - left.box.width * left.box.height
  ));
  const retained = [];
  for (const rectangle of ordered) {
    const nested = retained.some((outer) => (
      outer.box.width >= rectangle.box.width
      && outer.box.height >= rectangle.box.height
      && distance(center(outer.box), center(rectangle.box)) <= 0.035
      && containsPoint(outer.box, { x: rectangle.box.x, y: rectangle.box.y }, 0.005)
      && containsPoint(outer.box, { x: rectangle.box.x + rectangle.box.width, y: rectangle.box.y + rectangle.box.height }, 0.005)
    ));
    if (!nested) retained.push(rectangle);
  }
  return retained.map((outer) => {
    const nestedRectangle = ordered
      .filter((candidate) => candidate !== outer
        && outer.box.width > candidate.box.width
        && outer.box.height > candidate.box.height
        && distance(center(outer.box), center(candidate.box)) <= 0.035
        && containsPoint(outer.box, { x: candidate.box.x, y: candidate.box.y }, 0.005)
        && containsPoint(outer.box, { x: candidate.box.x + candidate.box.width, y: candidate.box.y + candidate.box.height }, 0.005))
      .sort((left, right) => right.box.width * right.box.height - left.box.width * left.box.height)[0] || null;
    return nestedRectangle ? {
      ...outer,
      nestedRectangle,
      borderInsets: {
        left: nestedRectangle.box.x - outer.box.x,
        top: nestedRectangle.box.y - outer.box.y,
        right: outer.box.x + outer.box.width - nestedRectangle.box.x - nestedRectangle.box.width,
        bottom: outer.box.y + outer.box.height - nestedRectangle.box.y - nestedRectangle.box.height,
      },
    } : outer;
  });
}

function bestInputRectangleForRegion(region, rectangles, textMatch = null, used = new Set()) {
  if (!region || rectangles.length === 0) return null;
  const modelCenter = center(region);
  let candidates = rectangles;
  let containedTextAnchor = false;
  if (textMatch) {
    const textCenter = center(textMatch.box);
    const containing = rectangles.filter((rectangle) => containsPoint(rectangle.box, textCenter));
    if (containing.length > 0) {
      candidates = containing;
      containedTextAnchor = true;
    }
  }
  let best = null;
  for (const candidate of candidates) {
    if (used.has(candidate)) continue;
    const candidateCenter = center(candidate.box);
    const proximity = distance(modelCenter, candidateCenter);
    const widthDelta = Math.abs(candidate.box.width - region.width);
    const rank = candidate.confidence - proximity * 0.45 - widthDelta * 0.15;
    if (!best || rank > best.rank) best = { ...candidate, sourceRectangle: candidate, rank };
  }
  // Without a matching placeholder/value, avoid snapping a distant input to
  // an unrelated rectangle elsewhere on the screen.
  if (!containedTextAnchor && best && distance(modelCenter, center(best.box)) > 0.12) return null;
  return best;
}

function bestInputRectangle(element, rectangles, textSources, used) {
  if (!INPUT_TYPES.has(element.elementType)) return null;
  const textMatch = bestTextMatch(element, textSources, () => true);
  return bestInputRectangleForRegion(element.approximateRegion, rectangles, textMatch, used);
}

function groundAbstractInputFields(element, rectangles) {
  const matchesByField = new Map();
  if (!element.abstraction || rectangles.length === 0) return { count: 0, matchesByField };
  const used = new Set();
  let count = 0;
  for (const field of element.abstraction.fields || []) {
    if (!INPUT_TYPES.has(field.elementType)) continue;
    const matchedIndices = new Set();
    const matches = [];
    field.instanceRegions = (field.instanceRegions || []).map((region, index) => {
      const match = bestInputRectangleForRegion(region, rectangles, null, used);
      if (!match) return region;
      used.add(match.sourceRectangle);
      matchedIndices.add(index);
      matches.push({ index, match });
      count += 1;
      return match.box;
    });
    const borderReference = matches.find(({ match }) => match.sourceRectangle?.nestedRectangle && match.sourceRectangle?.borderInsets);
    if (borderReference) {
      const outerBox = borderReference.match.sourceRectangle.box;
      const innerBox = borderReference.match.sourceRectangle.nestedRectangle.box;
      const insets = borderReference.match.sourceRectangle.borderInsets;
      for (const { index, match } of matches) {
        if (match.sourceRectangle?.nestedRectangle) continue;
        const box = match.box;
        const innerSimilarity = Math.abs(box.width - innerBox.width) + Math.abs(box.height - innerBox.height);
        const outerSimilarity = Math.abs(box.width - outerBox.width) + Math.abs(box.height - outerBox.height);
        if (innerSimilarity + 0.005 >= outerSimilarity) continue;
        field.instanceRegions[index] = clampBox({
          x: box.x - insets.left,
          y: box.y - insets.top,
          width: box.width + insets.left + insets.right,
          height: box.height + insets.top + insets.bottom,
        });
      }
    }
    matchesByField.set(field, matchedIndices);
  }
  return { count, matchesByField };
}

function repeatedFieldTerms(field) {
  return [...new Set([
    field?.label,
    ...(field?.visibleTexts || []),
    ...(field?.meaning?.evidence?.visibleTexts || []),
  ].map((value) => String(value || '').trim()).filter((value) => normalizedText(value).length >= 2))];
}

function monotonicRepeatedTextAssignment(slots, candidates) {
  if (slots.length === 0 || candidates.length < slots.length) return null;
  const lexicalScores = slots.map(({ field }) => {
    const terms = repeatedFieldTerms(field);
    return candidates.map((source) => Math.max(0, ...terms.map((term) => textScore(term, source.text))));
  });
  const requiresLexicalMatch = lexicalScores.map((scores) => Math.max(0, ...scores) >= 0.78);
  const memo = new Map();
  const solve = (slotIndex, candidateStart) => {
    if (slotIndex >= slots.length) return { cost: 0, sources: [] };
    const memoKey = `${slotIndex}:${candidateStart}`;
    if (memo.has(memoKey)) return memo.get(memoKey);
    const remainingSlots = slots.length - slotIndex - 1;
    let best = null;
    for (let candidateIndex = candidateStart; candidateIndex < candidates.length - remainingSlots; candidateIndex += 1) {
      const source = candidates[candidateIndex];
      const lexicalScore = lexicalScores[slotIndex][candidateIndex];
      if (requiresLexicalMatch[slotIndex] && lexicalScore < 0.78) continue;
      const region = slots[slotIndex].region;
      const heightCost = Math.abs(Math.log(Math.max(source.box.height, 0.001) / Math.max(region.height, 0.001)));
      const widthCost = Math.abs(source.box.width - region.width);
      const geometryCost = distance(center(source.box), center(region)) * 0.8
        + heightCost * 0.12 + widthCost * 0.08;
      const next = solve(slotIndex + 1, candidateIndex + 1);
      if (!next) continue;
      const cost = geometryCost - lexicalScore * (requiresLexicalMatch[slotIndex] ? 0.45 : 0.08) + next.cost;
      if (!best || cost < best.cost) best = { cost, sources: [source, ...next.sources] };
    }
    memo.set(memoKey, best);
    return best;
  };
  return solve(0, 0)?.sources || null;
}

// WebView fields are absent from UIAutomator. Use OCR text anchors for every
// abstract text field, including fields whose model label is only a generic
// template name (for example "段标题"). Matching by the field's existing
// vertical slot prevents the first row's estimate from drifting into later
// rows as the screenshot gets longer.
function groundAbstractTextFields(element, textSources) {
  if (!element.abstraction || textSources.length === 0) return 0;
  let count = 0;
  const used = new Set();
  const instanceCount = element.abstraction.instanceRegions?.length || 0;
  const elementTerms = semanticTerms(element);
  // A single-instance dynamic candidate often stores its observed payload
  // only on the parent label (for example "葛超烨" or "Onl..."). Keep that
  // value as evidence when it exactly appears in the runtime text sources;
  // generic semantic labels are deliberately excluded so they cannot pull a
  // field toward an unrelated heading.
  const dynamicPayloadTerms = element.abstraction?.kind === 'dynamic-template'
    && !CONTAINER_TYPES.has(element.elementType)
    ? elementTerms.filter((term) => textSources.some((source) => textScore(term, source.text) >= 0.98))
    : [];
  const inputRegions = (element.abstraction.fields || [])
    .filter((field) => INPUT_TYPES.has(field.elementType))
    .flatMap((field) => field.instanceRegions || [])
    .filter(Boolean);
  const textFields = (element.abstraction.fields || [])
    .filter((field) => (TEXT_TYPES.has(field.elementType) || field.elementType === 'text-button')
      && !structuralFieldRole(field));

  // For repeated structures, solve all text slots in a row together. A
  // nearest-neighbour match is ambiguous when adjacent fields have similar
  // labels (or no literal label at all), and can bind the first slot to the
  // second line. Grouping runtime nodes by template instance and assigning the
  // ordered field slots as one sequence keeps each row internally coherent.
  const repeatedAssignments = new Map();
  if (instanceCount >= 2 && textFields.length > 0
    && textFields.some((field) => (field.instanceRegions || []).some(Boolean))
    && textFields.every((field) => (field.instanceRegions || []).some(Boolean))) {
    const instanceRegions = element.abstraction.instanceRegions || [];
    const eligible = textSources.filter((source) => source.confidence >= 0.3
      && !source.combined
      && !inputRegions.some((input) => containsPoint(input, center(source.box), 0.002)));
    const rowCandidates = instanceRegions.map((instance) => ({
      instance,
      sources: [],
    }));
    for (const source of eligible) {
      const containing = rowCandidates
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => containsPoint(row.instance, center(source.box), 0.003));
      if (containing.length > 0) {
        const target = containing.sort((left, right) => (
          distance(center(left.row.instance), center(source.box))
            - distance(center(right.row.instance), center(source.box))
        ))[0];
        target.row.sources.push(source);
      }
    }
    const orderedFields = textFields.filter((field) => (field.instanceRegions || []).some(Boolean)).slice().sort((left, right) => (
      center(left.instanceRegions.find(Boolean)).y - center(right.instanceRegions.find(Boolean)).y
    ));
    for (const [rowIndex, row] of rowCandidates.entries()) {
      const fieldsInRow = orderedFields.map((field) => ({
        field,
        region: field.instanceRegions[rowIndex],
      })).filter((slot) => slot.region).sort((left, right) => center(left.region).y - center(right.region).y);
      const candidates = row.sources.slice().sort((left, right) => (
        center(left.box).y - center(right.box).y || left.box.x - right.box.x
      ));
      if (candidates.length < fieldsInRow.length) continue;
      const assignedSources = monotonicRepeatedTextAssignment(fieldsInRow, candidates);
      if (!assignedSources) continue;
      fieldsInRow.forEach((slot, index) => {
        const source = assignedSources[index];
        const assigned = repeatedAssignments.get(slot.field) || [];
        assigned[rowIndex] = source;
        repeatedAssignments.set(slot.field, assigned);
      });
    }
  }

  for (const field of element.abstraction.fields || []) {
    if (!TEXT_TYPES.has(field.elementType) && field.elementType !== 'text-button') continue;
    // Form marker, ordinal, label and placeholder boxes are split from the
    // complete OCR title/input geometry below. Letting generic OCR matching
    // claim them first reintroduces merged title rows and cross-instance drift.
    if (structuralFieldRole(field)) continue;
    const regions = field.instanceRegions || [];
    const permitsInputInterior = /placeholder|占位|提示/.test(`${field.key || ''} ${field.label || ''} ${field.description || ''}`.toLowerCase());
    const matchRegion = (region) => {
      if (!region) return null;
      const fieldTerms = semanticTerms({
        ...element,
        label: field.label,
        meaning: { evidence: { visibleTexts: field.visibleTexts || [] } },
      });
      const terms = regions.length >= 2 || dynamicPayloadTerms.length > 0
        ? [...new Set([...fieldTerms, ...dynamicPayloadTerms])]
        : fieldTerms;
      const regionCenter = center(region);
      const candidates = textSources
        .map((source, index) => {
          const score = Math.max(0, ...terms.map((term) => textScore(term, source.text)));
          const sourceHeight = Math.max(source.box.height, 0.001);
          const regionHeight = Math.max(region.height, 0.001);
          // Generic template labels often have no literal text to match. In
          // that case prefer an OCR box with a comparable text-line height and
          // confidence, rather than a tiny low-confidence glyph/noise box
          // that happens to be closest to the model's estimate.
          const heightSimilarity = Math.exp(-Math.abs(Math.log(sourceHeight / regionHeight)));
          const rank = score * 0.55 + (source.confidence || 0) * 0.12
            + heightSimilarity * 0.2 - distance(center(source.box), regionCenter);
          return { source, index, score, rank };
        })
        .filter(({ source, index, score }) => !used.has(index)
          && source.confidence >= 0.3
          // A structural container title is not a value for one of its
          // fields. This matters when a field label shares the title prefix
          // (for example a generic "<container> name" slot): exact title
          // matches would otherwise steal the field's runtime value.
          // A dynamic template's label is often the current payload itself
          // (for example a selected person's name). Do not discard that
          // exact runtime value as though it were a structural container
          // title; only static container labels get this exclusion.
          && !(element.abstraction?.kind !== 'dynamic-template'
            && CONTAINER_TYPES.has(element.elementType)
            && element.label && field.label
            && normalizedText(source.text) === normalizedText(element.label)
            && normalizedText(field.label) !== normalizedText(element.label))
          && (permitsInputInterior || !inputRegions.some((input) => containsPoint(input, center(source.box), 0.002)))
          && (regions.length >= instanceCount || score >= 0.78)
          && (score >= 0.78 || Math.abs(center(source.box).y - regionCenter.y) <= 0.08)
          && Math.abs(center(source.box).x - regionCenter.x) <= 0.25)
        .sort((left, right) => right.rank - left.rank);
      const match = candidates[0];
      if (!match) return region;
      used.add(match.index);
      count += 1;
      return match.source.box;
    };

    if (regions.length >= 2 && repeatedAssignments.size > 0) {
      const assigned = regions.map((region, index) => {
        const source = repeatedAssignments.get(field)?.[index];
        if (!source) return null;
        const sourceIndex = textSources.indexOf(source);
        if (sourceIndex >= 0) used.add(sourceIndex);
        count += 1;
        return source.box;
      });
      if (assigned.some(Boolean)) {
        field.instanceRegions = assigned.map((region, index) => region || regions[index]);
        continue;
      }
    }
    field.instanceRegions = (field.instanceRegions || []).map(matchRegion);
  }
  return count;
}

function separatorBandSources(ocr, screenshot) {
  const width = ocr?.width || screenshot?.width;
  const height = ocr?.height || screenshot?.height;
  const observations = Array.isArray(ocr?.separatorBands)
    ? ocr.separatorBands
    : (ocr?.horizontalBands || []).map((band) => ({ ...band, orientation: 'horizontal' }));
  return observations.map((observation) => ({
    orientation: observation.orientation === 'vertical' ? 'vertical' : 'horizontal',
    confidence: Number(observation.confidence) || 0,
    box: normalizedScreenshotRect(observation.rect, width, height),
  })).filter((item) => item.box
    && item.confidence >= 0.3
    && (item.orientation === 'horizontal'
      ? item.box.width >= 0.5 && item.box.height <= 0.08
      : item.box.height >= 0.5 && item.box.width <= 0.08));
}

function isFormLikeRepeatedTemplate(element) {
  if (element?.abstraction?.kind !== 'repeated-template') return false;
  if (element.elementType === 'form' || element.elementType === 'section') return true;
  const fields = element.abstraction.fields || [];
  return fields.some((field) => INPUT_TYPES.has(field.elementType))
    && fields.some((field) => TEXT_TYPES.has(field.elementType));
}

function inputCandidateScore(candidate, instance, templateRegion, direction) {
  const candidateBox = candidate.approximateRegion;
  const candidateCenter = center(candidateBox);
  const instanceCenter = center(instance);
  const instanceAxis = axisPosition(instance, direction);
  const candidateAxis = axisPosition(candidateBox, direction);
  const axisDistance = Math.abs(candidateAxis - instanceAxis);
  const crossStart = direction === 'vertical' ? instance.x : instance.y;
  const crossEnd = direction === 'vertical' ? instance.x + instance.width : instance.y + instance.height;
  const candidateCrossStart = direction === 'vertical' ? candidateBox.x : candidateBox.y;
  const candidateCrossEnd = direction === 'vertical'
    ? candidateBox.x + candidateBox.width
    : candidateBox.y + candidateBox.height;
  const crossOverlap = Math.max(0, Math.min(crossEnd, candidateCrossEnd) - Math.max(crossStart, candidateCrossStart));
  const crossSpan = Math.max(0.001, Math.min(crossEnd - crossStart, candidateCrossEnd - candidateCrossStart));
  const centerInInstance = containsPoint(instance, candidateCenter, 0.02);
  const centerInTemplate = containsPoint(templateRegion, candidateCenter, 0.02);
  if (!centerInTemplate) return Number.NEGATIVE_INFINITY;
  return (centerInInstance ? 2 : 0)
    + Math.min(crossOverlap / crossSpan, 1) * 0.8
    - axisDistance * 2
    - distance(candidateCenter, instanceCenter) * 0.15;
}

function ensureRepeatedTemplateInputFields(elements) {
  const allElements = Array.isArray(elements) ? elements : [];
  const inputCandidates = allElements.filter((candidate) => (
    INPUT_TYPES.has(candidate.elementType)
    && !candidate.abstraction
    && candidate.approximateRegion
  ));
  const claimed = new Set();
  let fieldCount = 0;
  for (const element of allElements) {
    if (element?.abstraction?.kind !== 'repeated-template') continue;
    const abstraction = element.abstraction;
    const instances = abstraction.instanceRegions || [];
    if (instances.length === 0) continue;
    const fields = abstraction.fields || (abstraction.fields = []);
    if (!fields.some((field) => TEXT_TYPES.has(field.elementType) || structuralFieldRole(field))) continue;
    let inputField = fields.find((field) => INPUT_TYPES.has(field.elementType));
    let createdInputField = false;
    if (!inputField) {
      const candidateType = inputCandidates.find((candidate) => (
        candidate.approximateRegion && containsPoint(element.approximateRegion || instances[0], center(candidate.approximateRegion), 0.02)
      ))?.elementType || 'text-area';
      inputField = {
        key: 'input',
        label: candidateType === 'input' ? '单行文本输入框' : '多行文本输入框',
        elementType: candidateType,
        description: '重复表单字段实例中的可编辑输入控件',
        displayCondition: '对应字段实例可见时显示',
        capabilities: ['tap', 'input'],
        interactionBoundary: 'candidate_bbox',
        actionEffects: [{ action: 'input', effect: '编辑当前字段实例内容' }],
        parentId: null,
        required: false,
        instanceRegions: [],
      };
      createdInputField = true;
    }
    const direction = repeatedTemplateDirection(instances);
    const templateRegion = element.approximateRegion || abstractBoundingBox(element) || unionBoxes(instances);
    const existingRegions = inputField.instanceRegions || [];
    const assigned = new Set();
    const pairs = [];
    instances.forEach((instance, instanceIndex) => {
      inputCandidates.forEach((candidate) => {
        if (claimed.has(candidate) || !candidate.approximateRegion) return;
        const score = inputCandidateScore(candidate, instance, templateRegion, direction);
        if (Number.isFinite(score)) pairs.push({ candidate, instanceIndex, score });
      });
    });
    pairs.sort((left, right) => right.score - left.score);
    for (const pair of pairs) {
      if (assigned.has(pair.instanceIndex) || claimed.has(pair.candidate)) continue;
      assigned.add(pair.instanceIndex);
      claimed.add(pair.candidate);
      existingRegions[pair.instanceIndex] = pair.candidate.approximateRegion;
    }
    if (createdInputField && assigned.size === 0) continue;
    const known = existingRegions.map((region, index) => ({ region, index })).filter(({ region }) => region);
    for (let index = 0; index < instances.length; index += 1) {
      if (existingRegions[index] || known.length === 0) continue;
      const anchor = [...known].sort((left, right) => Math.abs(left.index - index) - Math.abs(right.index - index))[0];
      const sourceInstance = instances[anchor.index];
      const targetInstance = instances[index];
      const source = anchor.region;
      if (direction === 'vertical') {
        const xRatio = (source.x - sourceInstance.x) / sourceInstance.width;
        const widthRatio = source.width / sourceInstance.width;
        const top = targetInstance.y + Math.max(0, source.y - sourceInstance.y);
        existingRegions[index] = clampBox({
          x: targetInstance.x + xRatio * targetInstance.width,
          y: top,
          width: widthRatio * targetInstance.width,
          height: Math.max(0.001, Math.min(source.height, targetInstance.y + targetInstance.height - top)),
        });
      } else {
        const yRatio = (source.y - sourceInstance.y) / sourceInstance.height;
        const heightRatio = source.height / sourceInstance.height;
        const left = targetInstance.x + Math.max(0, source.x - sourceInstance.x);
        existingRegions[index] = clampBox({
          x: left,
          y: targetInstance.y + yRatio * targetInstance.height,
          width: Math.max(0.001, Math.min(source.width, targetInstance.x + targetInstance.width - left)),
          height: heightRatio * targetInstance.height,
        });
      }
    }
    inputField.instanceRegions = existingRegions.slice(0, instances.length);
    if (createdInputField) {
      fields.push(inputField);
      fieldCount += 1;
    }
  }
  return { fieldCount, candidateCount: claimed.size };
}

function repeatedTemplateDirection(instances) {
  const centers = instances.map(center);
  const xSpread = Math.max(...centers.map((point) => point.x)) - Math.min(...centers.map((point) => point.x));
  const ySpread = Math.max(...centers.map((point) => point.y)) - Math.min(...centers.map((point) => point.y));
  return ySpread >= xSpread ? 'vertical' : 'horizontal';
}

function axisGeometry(box, direction) {
  return direction === 'vertical'
    ? { start: box.y, end: box.y + box.height, crossStart: box.x, crossEnd: box.x + box.width }
    : { start: box.x, end: box.x + box.width, crossStart: box.y, crossEnd: box.y + box.height };
}

function axisPosition(box, direction) {
  const axis = axisGeometry(box, direction);
  return (axis.start + axis.end) / 2;
}

function deriveVisualRepeatedBlockRegions(element, bands) {
  if (!isFormLikeRepeatedTemplate(element) || bands.length === 0) return { count: 0, partialCount: 0 };
  const abstraction = element.abstraction;
  const instances = abstraction.instanceRegions || [];
  if (instances.length === 0) return { count: 0, partialCount: 0 };
  const formBox = element.approximateRegion;
  const direction = repeatedTemplateDirection(instances);
  const separatorOrientation = direction === 'vertical' ? 'horizontal' : 'vertical';
  const formAxis = axisGeometry(formBox, direction);
  const usableBands = bands
    .filter((band) => {
      if (band.orientation !== separatorOrientation) return false;
      const bandAxis = axisGeometry(band.box, direction);
      const crossOverlap = Math.max(0, Math.min(formAxis.crossEnd, bandAxis.crossEnd) - Math.max(formAxis.crossStart, bandAxis.crossStart));
      const requiredCrossOverlap = Math.min(
        Math.max(0.05, (formAxis.crossEnd - formAxis.crossStart) * 0.45),
        (bandAxis.crossEnd - bandAxis.crossStart) * 0.8,
      );
      return bandAxis.end >= formAxis.start - 0.04
        && bandAxis.start <= formAxis.end + 0.04
        && crossOverlap >= requiredCrossOverlap;
    })
    .sort((left, right) => axisGeometry(left.box, direction).start - axisGeometry(right.box, direction).start);
  if (usableBands.length === 0) return { count: 0, partialCount: 0 };
  const fieldRegions = abstraction.fields || [];
  const spanningBand = [...usableBands].sort((left, right) => {
    const leftAxis = axisGeometry(left.box, direction);
    const rightAxis = axisGeometry(right.box, direction);
    return (rightAxis.crossEnd - rightAxis.crossStart) - (leftAxis.crossEnd - leftAxis.crossStart);
  })[0]?.box || null;
  const spanningAxis = spanningBand ? axisGeometry(spanningBand, direction) : null;
  const bandBoundaries = usableBands.map((band) => {
    const axis = axisGeometry(band.box, direction);
    const thickness = axis.end - axis.start;
    const position = (axis.start + axis.end) / 2;
    return {
      band,
      position,
      start: thickness <= 0.02 ? axis.start : position,
      end: thickness <= 0.02 ? axis.end : position,
    };
  });
  const formSpan = formAxis.end - formAxis.start;
  const edgeTolerance = Math.max(0.04, formSpan / Math.max(instances.length * 8, 1));
  const leading = bandBoundaries[0]?.position <= formAxis.start + edgeTolerance
    ? bandBoundaries.shift()
    : null;
  const trailing = bandBoundaries.at(-1)?.position >= formAxis.end - edgeTolerance
    ? bandBoundaries.pop()
    : null;
  const internalCount = instances.length - 1;
  // A single band immediately above a form is usually the navigation/content
  // boundary, not a separator between repeated instances. Rebuilding from it
  // would shorten every later instance and create cumulative upward drift.
  const hasInternalBoundary = bandBoundaries.some((boundary) => (
    boundary.position > formAxis.start + edgeTolerance
      && boundary.position < formAxis.end - edgeTolerance
  ));
  if (internalCount > 0 && !hasInternalBoundary) return { count: 0, partialCount: 0 };
  let internal = [];
  if (bandBoundaries.length >= internalCount) {
    const modelTargets = instances.slice(0, -1).map((instance, index) => (
      (axisPosition(instance, direction) + axisPosition(instances[index + 1], direction)) / 2
    ));
    let cursor = 0;
    for (let index = 0; index < internalCount; index += 1) {
      const lastCandidateIndex = bandBoundaries.length - (internalCount - index);
      let selectedIndex = cursor;
      for (let candidateIndex = cursor; candidateIndex <= lastCandidateIndex; candidateIndex += 1) {
        if (Math.abs(bandBoundaries[candidateIndex].position - modelTargets[index])
          < Math.abs(bandBoundaries[selectedIndex].position - modelTargets[index])) {
          selectedIndex = candidateIndex;
        }
      }
      internal.push(bandBoundaries[selectedIndex]);
      cursor = selectedIndex + 1;
    }
  } else {
    const instancePositions = instances.map((instance) => axisPosition(instance, direction));
    internal = instances.slice(0, -1).map((instance, index) => bandBoundaries
      .filter((boundary) => boundary.position > instancePositions[index]
        && boundary.position < instancePositions[index + 1])
      .sort((left, right) => Math.abs(left.position - (instancePositions[index] + instancePositions[index + 1]) / 2)
        - Math.abs(right.position - (instancePositions[index] + instancePositions[index + 1]) / 2))[0] || null);
  }
  const boundaries = [leading, ...internal, trailing];
  let count = 0;
  let partialCount = 0;
  for (let index = 0; index < instances.length; index += 1) {
    const regions = fieldRegions.map((field) => field.instanceRegions?.[index]).filter(Boolean);
    const previous = instances[index];
    const previousAxis = axisGeometry(previous, direction);
    const start = boundaries[index]?.end ?? previousAxis.start;
    const end = boundaries[index + 1]?.start ?? (index === instances.length - 1 ? formAxis.end : previousAxis.end);
    if (!(end > start)) continue;
    abstraction.instanceRegions[index] = clampBox(direction === 'vertical' ? {
      x: spanningAxis?.crossStart ?? previous.x,
      y: start,
      width: spanningAxis ? spanningAxis.crossEnd - spanningAxis.crossStart : previous.width,
      height: end - start,
    } : {
      x: start,
      y: spanningAxis?.crossStart ?? previous.y,
      width: end - start,
      height: spanningAxis ? spanningAxis.crossEnd - spanningAxis.crossStart : previous.height,
    });
    count += 1;
    if (index === instances.length - 1 && !boundaries[index + 1]) partialCount += 1;
  }
  return { count, partialCount };
}

function completeRepeatedInputGeometry(element, matchesByField) {
  if (element?.abstraction?.kind !== 'repeated-template') return 0;
  const instances = element.abstraction.instanceRegions || [];
  if (instances.length < 2) return 0;
  let count = 0;
  for (const field of element.abstraction.fields || []) {
    if (!INPUT_TYPES.has(field.elementType)) continue;
    const regions = field.instanceRegions || [];
    const matched = matchesByField.get(field) || new Set();
    const anchors = regions.map((region, index) => ({ region, index, instance: instances[index] }))
      .filter((item) => matched.has(item.index) && item.instance);
    if (anchors.length === 0) continue;
    const relativeLefts = anchors.map(({ region, instance }) => (region.x - instance.x) / instance.width).sort((left, right) => left - right);
    const relativeRights = anchors.map(({ region, instance }) => (
      (region.x + region.width - instance.x) / instance.width
    )).sort((left, right) => left - right);
    const topOffsets = anchors.map(({ region, instance }) => region.y - instance.y).sort((left, right) => left - right);
    const heights = anchors.map(({ region }) => region.height).sort((left, right) => left - right);
    const median = (values) => values.length % 2
      ? values[Math.floor(values.length / 2)]
      : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
    const relativeLeft = median(relativeLefts);
    const relativeRight = median(relativeRights);
    for (let index = 0; index < regions.length; index += 1) {
      const instance = instances[index];
      if (!instance) continue;
      if (matched.has(index)) continue;
      const left = instance.x + relativeLeft * instance.width;
      const right = instance.x + relativeRight * instance.width;
      const top = instance.y + median(topOffsets);
      const bottom = Math.min(instance.y + instance.height, top + median(heights));
      if (bottom <= top) continue;
      regions[index] = clampBox({ x: left, y: top, width: right - left, height: bottom - top });
      count += 1;
    }
  }
  return count;
}

function unionBoxes(boxes) {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return clampBox({ x: left, y: top, width: right - left, height: bottom - top });
}

function glyphWeight(character) {
  // TextView/DOM bounds cover the whole line, while structural fields need a
  // split at the rendered glyph boundary.  Digits, punctuation and spacing
  // occupy substantially less horizontal space than a CJK glyph; the old
  // weights over-estimated a short ordinal (for example `1.`), pushing the
  // following label's left edge to the right when no character fragments were
  // available.
  // An ideographic space is a real layout advance, unlike the thin spaces
  // commonly inserted after an ASCII ordinal.
  if (/\u3000/u.test(character)) return 0.5;
  if (/\s/u.test(character)) return 0.15;
  if (/[*＊✱✳]/u.test(character)) return 0.55;
  // Full-width punctuation (for example `、`/`．`) consumes roughly one CJK
  // cell; ASCII punctuation is materially narrower.
  if (/[．、（）［］【】「」『』]/u.test(character)) return 0.8;
  if (/\p{P}/u.test(character)) return 0.25;
  if (/\p{Script=Han}/u.test(character)) return 1;
  if (/\p{N}/u.test(character)) return 0.45;
  return 0.65;
}

function textRangeBox(source, start, end) {
  const fragments = (source.fragments || []).filter((fragment) => {
    const fragmentStart = Number(fragment.start);
    const fragmentEnd = Number(fragment.end);
    return Number.isFinite(fragmentStart) && Number.isFinite(fragmentEnd)
      && fragmentEnd > start && fragmentStart < end;
  });
  const fragmentBox = unionBoxes(fragments.map((fragment) => fragment.box));
  if (fragmentBox) return fragmentBox;

  const glyphs = [];
  let offset = 0;
  for (const character of String(source.text || '')) {
    const nextOffset = offset + character.length;
    glyphs.push({ start: offset, end: nextOffset, weight: glyphWeight(character) });
    offset = nextOffset;
  }
  const totalWeight = glyphs.reduce((sum, glyph) => sum + glyph.weight, 0);
  const beforeWeight = glyphs.filter((glyph) => glyph.end <= start).reduce((sum, glyph) => sum + glyph.weight, 0);
  const rangeWeight = glyphs.filter((glyph) => glyph.end > start && glyph.start < end).reduce((sum, glyph) => sum + glyph.weight, 0);
  if (!(totalWeight > 0) || !(rangeWeight > 0)) return source.box;
  if (source.box.width >= source.box.height) {
    return clampBox({
      x: source.box.x + source.box.width * beforeWeight / totalWeight,
      y: source.box.y,
      width: source.box.width * rangeWeight / totalWeight,
      height: source.box.height,
    });
  }
  return clampBox({
    x: source.box.x,
    y: source.box.y + source.box.height * beforeWeight / totalWeight,
    width: source.box.width,
    height: source.box.height * rangeWeight / totalWeight,
  });
}

function exactTextRangeBox(source, start, end) {
  const fragments = (source.fragments || []).filter((fragment) => {
    const fragmentStart = Number(fragment.start);
    const fragmentEnd = Number(fragment.end);
    return Number.isFinite(fragmentStart) && Number.isFinite(fragmentEnd)
      && fragmentEnd > start && fragmentStart < end;
  });
  return unionBoxes(fragments.map((fragment) => fragment.box));
}

function trimmedGroupRange(text, range) {
  if (!range || range.length < 2) return null;
  let [start, end] = range;
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  return end > start ? [start, end] : null;
}

function parseFormTitleSource(source) {
  const text = String(source.text || '');
  const match = /^(\s*[*＊✱✳]\s*)?(\d+\s*[.．、)]\s*)?(.+?)\s*$/du.exec(text);
  if (!match?.indices) return null;
  const markerRange = trimmedGroupRange(text, match.indices[1]);
  const ordinalRange = trimmedGroupRange(text, match.indices[2]);
  const labelRange = trimmedGroupRange(text, match.indices[3]);
  if (!labelRange || (!markerRange && !ordinalRange)) return null;
  const exactLabelBox = exactTextRangeBox(source, ...labelRange);
  return {
    source,
    markerText: markerRange ? text.slice(...markerRange) : null,
    markerBox: markerRange ? textRangeBox(source, ...markerRange) : null,
    ordinalText: ordinalRange ? text.slice(...ordinalRange) : null,
    ordinalBox: ordinalRange ? textRangeBox(source, ...ordinalRange) : null,
    labelText: text.slice(...labelRange),
    // Runtime title nodes often expose one box for the complete line
    // (for example "1. 今日完成工作"). Derive the label from its text range
    // so the ordinal cannot be folded into the field-label region. OCR
    // fragments remain exact; runtime nodes use the weighted glyph fallback.
    labelBox: exactLabelBox || textRangeBox(source, ...labelRange),
    labelBoxExact: Boolean(exactLabelBox),
  };
}

function structuralFieldRole(field) {
  const value = `${field?.key || ''} ${field?.label || ''}`.toLowerCase();
  if (/required[-_ ]?marker|mandatory[-_ ]?marker|asterisk|必填标记|必填星号/u.test(value)) return 'required-marker';
  if (/ordinal|sequence[-_ ]?(number|marker)|序号|编号/u.test(value)) return 'ordinal';
  if (/placeholder|占位|提示语/u.test(value)) return 'placeholder';
  if (/field[-_ ]?label|field[-_ ]?title|字段标签|字段标题/u.test(value)) return 'field-label';
  return null;
}

function staticStructuralField(existing, { key, label, description, displayCondition, regions }) {
  return {
    ...(existing || {}),
    key,
    label,
    elementType: 'static-label',
    description,
    displayCondition,
    capabilities: ['none'],
    interactionBoundary: 'none',
    actionEffects: [{ action: 'none', effect: '仅展示可见结构信息，不触发交互' }],
    parentId: existing?.parentId || null,
    required: false,
    instanceRegions: regions,
  };
}

function repeatedPlaceholderRegions(inputRegions, textSources, existingPlaceholder) {
  const candidates = inputRegions.map((input, instanceIndex) => {
    if (!input) return null;
    return textSources.map((source) => {
      const sourceCenter = center(source.box);
      if (!containsPoint(input, sourceCenter, 0.001)) return null;
      const relativeX = (sourceCenter.x - input.x) / input.width;
      const relativeY = (sourceCenter.y - input.y) / input.height;
      if (relativeX > 0.3 || relativeY > 0.24) return null;
      if (source.box.height > Math.max(0.04, input.height * 0.22)) return null;
      const textKey = normalizedText(source.text);
      if (!textKey || Array.from(textKey).length > 20) return null;
      return { source, instanceIndex, textKey, rank: source.confidence - relativeX * 0.2 - relativeY * 0.25 };
    }).filter(Boolean).sort((left, right) => right.rank - left.rank)[0] || null;
  }).filter(Boolean);
  const counts = new Map();
  for (const candidate of candidates) counts.set(candidate.textKey, (counts.get(candidate.textKey) || 0) + 1);
  const repeated = candidates.filter((candidate) => (counts.get(candidate.textKey) || 0) >= 2);
  const alignVisibleRegions = (items) => {
    if (items.length === 0) return [];
    const highestIndex = Math.max(...items.map((item) => item.instanceIndex));
    const regions = Array.from({ length: highestIndex + 1 }, () => null);
    for (const item of items) regions[item.instanceIndex] = item.source.box;
    return regions;
  };
  if (repeated.length > 0) return alignVisibleRegions(repeated);
  if (!existingPlaceholder) return [];
  return alignVisibleRegions(candidates.filter((candidate) => (existingPlaceholder.instanceRegions || []).some((region) => (
    region && distance(center(region), center(candidate.source.box)) <= 0.08
  ))));
}

function alignedVisibleStructuralRegions(parsedTitles, property) {
  const parsedRegions = parsedTitles.map((parsed) => parsed?.[property] || null);
  // Trailing absent instances are intentionally omitted (there is no later
  // index to align), while an absent middle instance remains an explicit null
  // slot so subsequent observed regions keep their template index.
  let lastVisibleIndex = -1;
  parsedRegions.forEach((region, index) => {
    if (region) lastVisibleIndex = index;
  });
  return lastVisibleIndex >= 0 ? parsedRegions.slice(0, lastVisibleIndex + 1) : [];
}

function restoreFormTemplateStructuralFields(element, textSources) {
  if (!isFormLikeRepeatedTemplate(element) || textSources.length === 0) return { fieldCount: 0, regionCount: 0 };
  const abstraction = element.abstraction;
  const instances = abstraction.instanceRegions || [];
  const previousInstances = instances.map((instance) => ({ ...instance }));
  const fields = abstraction.fields || [];
  const inputField = fields.find((field) => INPUT_TYPES.has(field.elementType));
  if (!inputField || instances.length < 2) return { fieldCount: 0, regionCount: 0 };

  const existingByRole = new Map(fields.map((field) => [structuralFieldRole(field), field]).filter(([role]) => role));
  const genericTitleField = fields.find((field) => (
    (TEXT_TYPES.has(field.elementType) || field.elementType === 'text-button')
    && !structuralFieldRole(field)
  )) || existingByRole.get('field-label') || null;
  const parsedTitleSources = textSources.map(parseFormTitleSource).filter(Boolean).sort((left, right) => center(left.source.box).y - center(right.source.box).y);
  const parsedTitles = instances.map((instance, index) => {
    const expected = genericTitleField?.instanceRegions?.[index] || instance;
    return parsedTitleSources.filter((parsed) => {
      const sourceCenter = center(parsed.source.box);
      return containsPoint(instance, sourceCenter, 0.003)
        // The model's input bbox may be too tall when the lower control is
        // cropped. Title parsing is stricter (ordinal/marker required), so
        // do not discard a valid title merely because it falls inside that
        // provisional input region.
        && parsed.labelText.length > 0;
    }).map((parsed) => ({
      ...parsed,
      rank: (parsed.ordinalBox ? 0.8 : 0) + (parsed.markerBox ? 0.1 : 0)
        + parsed.source.confidence * 0.1 - distance(center(expected), center(parsed.source.box)),
    })).sort((left, right) => right.rank - left.rank)[0] || null;
  });
  // A model that used device-viewport coordinates can place every instance
  // outside its actual full-page position. When at least two ordinal titles
  // are available from UI Automation/DOM/OCR, bind them by vertical order so
  // the structural fields can recover the correct page coordinate space.
  if (parsedTitles.filter((parsed) => parsed?.ordinalBox).length < 2 && parsedTitleSources.length >= 2) {
    const orderedInstances = instances.map((instance, index) => ({ instance, index }))
      .sort((left, right) => left.instance.y - right.instance.y);
    const orderedTitles = parsedTitleSources.filter((parsed) => parsed.ordinalBox).slice(0, orderedInstances.length);
    for (let index = 0; index < orderedTitles.length; index += 1) {
      parsedTitles[orderedInstances[index].index] = orderedTitles[index];
    }
  }
  if (parsedTitles.filter((parsed) => parsed?.ordinalBox).length < 2) return { fieldCount: 0, regionCount: 0 };

  const orderedOrdinalTitles = parsedTitleSources.filter((parsed) => parsed.ordinalBox);
  for (let index = 0; index < parsedTitles.length; index += 1) {
    const parsed = parsedTitles[index];
    if (!parsed?.ordinalBox) continue;
    const titleTop = parsed.source.box.y;
    const next = orderedOrdinalTitles.find((candidate) => center(candidate.source.box).y > center(parsed.source.box).y + 0.001);
    const nextTop = next?.source.box.y;
    const start = Math.max(0, titleTop - 0.012);
    if (previousInstances[index] && Math.abs(previousInstances[index].y - start) <= 0.04) continue;
    const end = nextTop
      ? Math.max(start + 0.01, nextTop - 0.012)
      : Math.min(1, start + Math.min(0.12, Math.max(0.04, instances[index]?.height || 0.08)));
    instances[index] = clampBox({ x: 0, y: start, width: 1, height: end - start });
  }

  // Translate an ungrounded input slot with its old template instance when a
  // model used device-viewport coordinates. A slot that is already inside the
  // recovered instance is left untouched because its screenshot coordinates
  // are consistent; no equal-spacing extrapolation is performed.
  for (const field of fields.filter((candidate) => INPUT_TYPES.has(candidate.elementType))) {
    field.instanceRegions = (field.instanceRegions || []).map((region, index) => {
      const instance = instances[index];
      const previous = previousInstances[index];
      if (!instance || !previous || regionContainsSource(instance, { box: region })) return region;
      const shifted = { ...region, y: region.y + instance.y - previous.y };
      return clampBox({
        ...shifted,
        y: Math.max(instance.y, shifted.y),
        height: Math.min(shifted.height, instance.y + instance.height - Math.max(instance.y, shifted.y)),
      });
    });
  }

  for (let index = 0; index < parsedTitles.length; index += 1) {
    const parsed = parsedTitles[index];
    if (!parsed || parsed.markerBox) continue;
    const anchor = parsed.ordinalBox || parsed.labelBox;
    const standaloneMarker = textSources.find((source) => (
      /^\s*[*＊✱✳]\s*$/u.test(source.text)
      && Math.abs(center(source.box).y - center(anchor).y) <= Math.max(anchor.height, source.box.height) * 1.5
      && source.box.x + source.box.width <= anchor.x + 0.02
      && containsPoint(instances[index], center(source.box), 0.003)
    ));
    if (standaloneMarker) {
      parsed.markerText = standaloneMarker.text.trim();
      parsed.markerBox = standaloneMarker.box;
    }
  }

  // A native TextView may expose the required asterisk as a sibling node,
  // while the title node itself starts at the sequence number. Recover the
  // nearest visible marker independently of the provisional instance box so
  // a small boundary discrepancy cannot erase the required field.
  const standaloneMarkers = textSources.filter((source) => /^\s*[*＊✱✳]\s*$/u.test(source.text));
  for (const marker of standaloneMarkers) {
    const target = parsedTitles
      .map((parsed, index) => ({ parsed, index }))
      .filter(({ parsed }) => parsed?.ordinalBox || parsed?.labelBox)
      .map(({ parsed, index }) => {
        const anchor = parsed.ordinalBox || parsed.labelBox;
        return {
          parsed,
          index,
          distance: Math.abs(center(marker.box).y - center(anchor).y),
          leftOfTitle: marker.box.x + marker.box.width <= anchor.x + 0.035,
        };
      })
      .filter((candidate) => candidate.leftOfTitle && candidate.distance <= 0.02)
      .sort((left, right) => left.distance - right.distance)[0];
    if (target && !target.parsed.markerBox) target.parsed.markerBox = marker.box;
  }

  // Keep structural field arrays aligned with template instances. Filtering
  // missing observations here would make an observed third title render as
  // instance two (and can shift every later field during normalization).
  // An unobserved middle slot remains an explicit null rather than being
  // compressed. Trailing absent slots are trimmed below because they have no
  // later observed index that needs preserving.
  const markerRegions = alignedVisibleStructuralRegions(
    parsedTitles, 'markerBox',
  );
  const ordinalRegions = alignedVisibleStructuralRegions(
    parsedTitles, 'ordinalBox',
  );
  const existingLabelField = existingByRole.get('field-label') || genericTitleField;
  const labelRegions = parsedTitles.map((parsed, index) => {
    if (!parsed?.labelBox || parsed.labelBoxExact) return parsed?.labelBox || null;
    const existing = existingLabelField?.instanceRegions?.[index];
    if (!existing) return parsed.labelBox;
    // A model may split a complete line into an ordinal and label but reserve
    // the ordinal's punctuation/spacing twice, leaving the label boundary
    // visibly too far right.  The range-derived box is the best generic
    // estimate when the disagreement exceeds a small line-relative tolerance;
    // retain a close existing boundary because runtime boxes without
    // character fragments cannot prove a finer distinction.
    const inferredDelta = existing.x - parsed.labelBox.x;
    const boundaryTolerance = Math.max(0.004, Math.min(0.012, parsed.source.box.width * 0.015));
    if (inferredDelta > boundaryTolerance) return parsed.labelBox;
    const ordinalRight = parsed.ordinalBox ? parsed.ordinalBox.x + parsed.ordinalBox.width : parsed.source.box.x;
    const sourceRight = parsed.source.box.x + parsed.source.box.width;
    const alreadySeparated = existing.x >= ordinalRight - 0.015
      && existing.x >= parsed.source.box.x - 0.005
      && existing.x < sourceRight + 0.005
      && existing.width > 0.005;
    if (!alreadySeparated) return parsed.labelBox;
    return clampBox({
      x: existing.x,
      y: parsed.labelBox.y,
      width: Math.min(existing.width, Math.max(0.005, sourceRight - existing.x)),
      height: parsed.labelBox.height,
    });
  });
  const alignedLabelRegions = (() => {
    let lastVisibleIndex = -1;
    labelRegions.forEach((region, index) => {
      if (region) lastVisibleIndex = index;
    });
    return lastVisibleIndex >= 0 ? labelRegions.slice(0, lastVisibleIndex + 1) : [];
  })();
  const visibleLabels = parsedTitles.map((parsed) => parsed?.labelText?.trim()).filter(Boolean);
  const placeholderRegions = repeatedPlaceholderRegions(
    inputField.instanceRegions || [],
    textSources,
    existingByRole.get('placeholder'),
  );
  const existingPlaceholder = existingByRole.get('placeholder');
  const visiblePlaceholderEvidence = semanticTerms(element).some((term) => placeholderText(term));
  const effectivePlaceholderRegions = placeholderRegions.length > 0
    ? placeholderRegions
      : (visiblePlaceholderEvidence ? (existingPlaceholder?.instanceRegions || []) : []);
  const structural = [];
  if (markerRegions.some(Boolean)) structural.push(staticStructuralField(existingByRole.get('required-marker'), {
    key: 'required-marker', label: '必填标记', description: '仅记录截图中实际可见的必填标记',
    displayCondition: '对应字段为必填且标记可见时显示', regions: markerRegions,
  }));
  if (ordinalRegions.some(Boolean)) structural.push(staticStructuralField(existingByRole.get('ordinal'), {
    key: 'ordinal', label: '填写项序号', description: '区分重复表单字段实例的可见序号',
    displayCondition: '实例带可见序号时显示', regions: ordinalRegions,
  }));
  if (alignedLabelRegions.some(Boolean)) structural.push(staticStructuralField(existingByRole.get('field-label'), {
    key: 'field-label', label: '字段标签',
    description: `各实例的可见字段标签：${visibleLabels.join('、')}`,
    displayCondition: '字段标签可见时显示', regions: alignedLabelRegions,
  }));
  if (effectivePlaceholderRegions.length > 0) structural.push(staticStructuralField(existingByRole.get('placeholder'), {
    key: 'placeholder', label: '输入提示语', description: '输入框未填写时在框内显示的可见提示语',
    displayCondition: '输入框为空且提示语在截图中可见时显示', regions: effectivePlaceholderRegions,
  }));

  const replaced = new Set([...existingByRole.values(), genericTitleField].filter(Boolean));
  const preserved = fields.filter((field) => !replaced.has(field) && !INPUT_TYPES.has(field.elementType));
  const inputFields = fields.filter((field) => INPUT_TYPES.has(field.elementType));
  abstraction.fields = [...structural, ...preserved, ...inputFields];
  return {
    fieldCount: structural.length,
    regionCount: structural.reduce((count, field) => count + field.instanceRegions.filter(Boolean).length, 0),
  };
}

function recomputeAbstractInstanceRegions(element) {
  if (!element.abstraction) return;
  const instances = element.abstraction.instanceRegions || [];
  const fields = element.abstraction.fields || [];
  for (let index = 0; index < instances.length; index += 1) {
    const regions = fields.map((field) => field.instanceRegions?.[index]).filter(Boolean);
    if (regions.length === 0) continue;
    const left = Math.min(...regions.map((region) => region.x));
    const top = Math.min(...regions.map((region) => region.y));
    const right = Math.max(...regions.map((region) => region.x + region.width));
    const bottom = Math.max(...regions.map((region) => region.y + region.height));
    const previous = instances[index];
    const previousRight = (previous?.x || 0) + (previous?.width || 0);
    const previousBottom = (previous?.y || 0) + (previous?.height || 0);
    const boundaryTolerance = 0.015;
    // Field grounding commonly produces a tighter child rectangle than the
    // model's block boundary. Do not move the block upward just to add a
    // padding margin when every grounded field is already inside it; preserve
    // the original full-page instance coordinate in that case.
    if (previous
      && left >= previous.x - boundaryTolerance
      && top >= previous.y - boundaryTolerance
      && right <= previousRight + boundaryTolerance
      && bottom <= previousBottom + boundaryTolerance) continue;
    instances[index] = clampBox({
      x: Math.min(left, previous?.x ?? left),
      y: Math.min(previous?.y ?? top, Math.max(0, top - 0.01)),
      width: Math.max(right, previousRight) - Math.min(left, previous?.x ?? left),
      height: Math.min(1, Math.max(bottom, previousBottom) + 0.01) - Math.min(previous?.y ?? top, Math.max(0, top - 0.01)),
    });
  }
}

function rebuildRepeatedFormBoundaries(element) {
  if (!isFormLikeRepeatedTemplate(element)) return 0;
  const abstraction = element.abstraction;
  const instances = abstraction.instanceRegions || [];
  const titleField = (abstraction.fields || []).find((field) => structuralFieldRole(field) === 'field-label')
    || (abstraction.fields || []).find((field) => TEXT_TYPES.has(field.elementType));
  const inputField = (abstraction.fields || []).find((field) => INPUT_TYPES.has(field.elementType));
  if (!titleField || !inputField || instances.length < 2) return 0;
  let changed = 0;
  const titleRegions = titleField.instanceRegions || [];
  const inputRegions = inputField.instanceRegions || [];
  for (let index = 0; index < instances.length; index += 1) {
    const title = titleRegions[index];
    const input = inputRegions[index];
    if (!title || !input) continue;
    const nextTitle = titleRegions[index + 1];
    const start = Math.max(0, title.y - 0.006);
    const end = nextTitle
      ? Math.max(start + 0.005, nextTitle.y - 0.006)
      : Math.min(1, input.y + input.height + 0.01);
    const previous = instances[index];
    const fullWidth = previous && previous.x <= 0.01 && previous.width >= 0.95;
    const next = clampBox(fullWidth ? {
      x: 0,
      y: start,
      width: 1,
      height: end - start,
    } : {
      x: Math.min(title.x, input.x),
      y: start,
      width: Math.max(title.x + title.width, input.x + input.width) - Math.min(title.x, input.x),
      height: end - start,
    });
    if (!previous || Math.abs(previous.y - next.y) > 0.0005 || Math.abs(previous.height - next.height) > 0.0005) {
      instances[index] = next;
      changed += 1;
    }
  }
  if (changed > 0) element.approximateRegion = abstractBoundingBox(element) || element.approximateRegion;
  return changed;
}

function calibrationAnchors(elements, sources) {
  const anchors = [];
  const usedSources = new Set();
  const sourceTextCounts = new Map();
  for (const source of sources) {
    const key = normalizedText(source.text);
    sourceTextCounts.set(key, (sourceTextCounts.get(key) || 0) + 1);
  }
  for (const element of elements) {
    const terms = semanticTerms(element);
    const regions = anchorRegions(element);
    if (terms.length === 0 || regions.length === 0) continue;
    const matches = [];
    for (const term of terms) {
      let best = null;
      sources.forEach((source, index) => {
        if (usedSources.has(index) || source.confidence < 0.45 || sourceTextCounts.get(normalizedText(source.text)) > 1) return;
        const score = textScore(term, source.text);
        if (score < 0.82) return;
        const rank = score + source.confidence * 0.05;
        if (!best || rank > best.rank) best = { source, index, score, rank };
      });
      if (best) matches.push(best);
    }
    matches.sort((left, right) => center(left.source.box).y - center(right.source.box).y);
    const availableRegions = [...regions].sort((left, right) => center(left).y - center(right).y);
    for (const match of matches) {
      if (availableRegions.length === 0) break;
      const target = center(match.source.box);
      let regionIndex = 0;
      let bestCost = Number.POSITIVE_INFINITY;
      availableRegions.forEach((region, index) => {
        const positionCost = distance(center(region), target);
        const heightCost = Math.abs(Math.log(Math.max(region.height, 0.001) / Math.max(match.source.box.height, 0.001))) * 0.08;
        const widthCost = Math.abs(region.width - match.source.box.width) * 0.12;
        const candidateCost = positionCost + heightCost + widthCost;
        if (candidateCost < bestCost) { bestCost = candidateCost; regionIndex = index; }
      });
      const region = availableRegions.splice(regionIndex, 1)[0];
      anchors.push({ model: center(region), actual: target, weight: match.source.confidence || 0.8 });
      usedSources.add(match.index);
    }
  }
  return anchors;
}

function fitAxis(anchors, axis) {
  if (anchors.length === 0) return { scale: 1, offset: 0, reliable: false, residual: null };
  const modelValues = anchors.map((anchor) => anchor.model[axis]);
  const actualValues = anchors.map((anchor) => anchor.actual[axis]);
  const modelMean = modelValues.reduce((sum, value) => sum + value, 0) / modelValues.length;
  const actualMean = actualValues.reduce((sum, value) => sum + value, 0) / actualValues.length;
  const variance = modelValues.reduce((sum, value) => sum + (value - modelMean) ** 2, 0);
  const covariance = anchors.reduce((sum, anchor) => sum + (anchor.model[axis] - modelMean) * (anchor.actual[axis] - actualMean), 0);
  const spread = Math.max(...modelValues) - Math.min(...modelValues);
  const scale = variance > 0.0025 ? covariance / variance : 1;
  const boundedScale = scale >= 0.65 && scale <= 1.55 ? scale : 1;
  const offset = actualMean - boundedScale * modelMean;
  const residual = Math.sqrt(anchors.reduce((sum, anchor) => sum + (anchor.actual[axis] - (boundedScale * anchor.model[axis] + offset)) ** 2, 0) / anchors.length);
  return {
    scale: boundedScale,
    offset,
    residual,
    reliable: anchors.length >= 2 && spread >= (axis === 'y' ? 0.15 : 0.08) && residual <= 0.055,
  };
}

function clampBox(box) {
  const x = Math.min(Math.max(box.x, 0), 0.9999);
  const y = Math.min(Math.max(box.y, 0), 0.9999);
  const right = Math.min(Math.max(box.x + box.width, x + 0.0001), 1);
  const bottom = Math.min(Math.max(box.y + box.height, y + 0.0001), 1);
  return { x, y, width: right - x, height: bottom - y };
}

function transformBox(box, calibration) {
  const left = calibration.x.scale * box.x + calibration.x.offset;
  const top = calibration.y.scale * box.y + calibration.y.offset;
  const right = calibration.x.scale * (box.x + box.width) + calibration.x.offset;
  const bottom = calibration.y.scale * (box.y + box.height) + calibration.y.offset;
  return clampBox({ x: left, y: top, width: right - left, height: bottom - top });
}

function transformElementRegions(element, calibration) {
  element.approximateRegion = transformBox(element.approximateRegion, calibration);
  if (!element.abstraction) return;
  element.abstraction.instanceRegions = (element.abstraction.instanceRegions || []).map((box) => (
    box ? transformBox(box, calibration) : box
  ));
  for (const field of element.abstraction.fields || []) {
    field.instanceRegions = (field.instanceRegions || []).map((box) => (
      box ? transformBox(box, calibration) : box
    ));
  }
}

function expandedTextButtonBox(box, ocr, screenshot) {
  const width = ocr?.width || screenshot?.width;
  const height = ocr?.height || screenshot?.height;
  const horizontalPad = width && height ? box.height * height / width * 0.4 : box.height * 0.4;
  const verticalPad = box.height * 0.4;
  return clampBox({
    x: box.x - horizontalPad,
    y: box.y - verticalPad,
    width: box.width + horizontalPad * 2,
    height: box.height + verticalPad * 2,
  });
}

function clipTextButtonAtAdjacentControls(box, element, elements) {
  const verticalCenter = center(box).y;
  const right = box.x + box.width;
  const rightNeighbor = (elements || [])
    .filter((candidate) => candidate !== element
      && BUTTON_TYPES.has(candidate.elementType)
      && candidate.approximateRegion
      && candidate.approximateRegion.x >= box.x
      && verticalCenter >= candidate.approximateRegion.y - 0.005
      && verticalCenter <= candidate.approximateRegion.y + candidate.approximateRegion.height + 0.005)
    .sort((left, candidate) => left.approximateRegion.x - candidate.approximateRegion.x)[0];
  if (!rightNeighbor || right <= rightNeighbor.approximateRegion.x) return box;
  return clampBox({
    ...box,
    width: Math.max(0.001, rightNeighbor.approximateRegion.x - box.x),
  });
}

function abstractBoundingBox(element) {
  const instances = element.abstraction?.instanceRegions || [];
  if (instances.length === 0) return null;
  const left = Math.min(...instances.map((region) => region.x));
  const top = Math.min(...instances.map((region) => region.y));
  const right = Math.max(...instances.map((region) => region.x + region.width));
  const bottom = Math.max(...instances.map((region) => region.y + region.height));
  return clampBox({ x: left, y: top, width: right - left, height: bottom - top });
}

function screenshotCoordinatesAligned(hierarchy, screenshot) {
  if (!hierarchy?.viewport?.width || !hierarchy?.viewport?.height || !screenshot?.width || !screenshot?.height) return false;
  const screenshotAspect = screenshot.width / screenshot.height;
  const viewportAspect = hierarchy.viewport.width / hierarchy.viewport.height;
  return Number.isFinite(screenshotAspect)
    && Number.isFinite(viewportAspect)
    && Math.abs(screenshotAspect - viewportAspect) <= 0.002;
}

function isFullPageScreenshot(hierarchy, screenshot) {
  return Boolean(hierarchy?.fullPage || hierarchy?.origin === 'full_page'
    || (hierarchy?.viewport?.width && hierarchy?.viewport?.height
    && screenshot?.width && screenshot?.height
    && screenshot.height > hierarchy.viewport.height * 1.05
    && Math.abs(screenshot.width / hierarchy.viewport.width - 1) <= 0.08));
}

function groundingSignal(source) {
  if (source === 'dom') return 'geometry-grounded-by-dom';
  return 'geometry-grounded-by-ui-tree';
}

function fixedRuntimeBoxes(runtimeStructure, viewport) {
  const hierarchy = runtimeStructure?.hierarchy || runtimeStructure;
  const hierarchyNodes = Array.isArray(hierarchy?.fixedNodes) ? hierarchy.fixedNodes : [];
  const domNodes = Array.isArray(runtimeStructure?.dom?.fixedNodes) ? runtimeStructure.dom.fixedNodes : [];
  return [...hierarchyNodes, ...domNodes]
    .map((node) => normalizedDisplayBounds(node?.bounds, viewport))
    .filter(Boolean)
    .filter((box, index, boxes) => boxes.findIndex((candidate) => normalizedBoxOverlap(candidate, box) >= 0.8) === index);
}

function markFixedPositionElements(result, runtimeStructure, viewport) {
  const fixedBoxes = fixedRuntimeBoxes(runtimeStructure, viewport);
  if (fixedBoxes.length === 0) return 0;
  let count = 0;
  for (const element of result.elements || []) {
    element.riskSignals = (element.riskSignals || []).filter((signal) => signal !== 'fixed-position');
    const regions = (element.abstraction?.instanceRegions?.length
      ? element.abstraction.instanceRegions
      : [element.approximateRegion]).filter(Boolean);
    // Long-page scroll content can pass behind a fixed footer and therefore
    // overlap it substantially. A fixed match must describe the same runtime
    // node in both directions, not merely cover part of a scrolling card.
    const fixedRegionCount = regions.filter((region) => fixedBoxes.some((box) => (
      normalizedBoxCoverage(region, box) >= 0.6
        && normalizedBoxCoverage(box, region) >= 0.6
    ))).length;
    if (fixedRegionCount > 0 && fixedRegionCount === regions.length) {
      element.riskSignals = [...new Set([...(element.riskSignals || []), 'fixed-position'])];
      count += 1;
    }
  }
  return count;
}

function pruneCrossPositionContainment(result) {
  const fixedByKey = new Map((result.elements || []).map((element) => [
    element.candidateKey,
    (element.riskSignals || []).includes('fixed-position'),
  ]));
  result.relationships = (result.relationships || []).filter((relation) => (
    relation.type !== 'contains'
      || fixedByKey.get(relation.fromCandidateKey) === fixedByKey.get(relation.toCandidateKey)
  ));
}

function repairRuntimeScrollableContainment(result, runtimeStructure, viewport) {
  const hierarchy = runtimeStructure?.hierarchy || runtimeStructure;
  const scrollBounds = flatten(hierarchy?.root)
    .filter((node) => node?.scrollable && node.bounds)
    .map((node) => normalizedDisplayBounds(node.bounds, viewport))
    .filter(Boolean)
    .sort((left, right) => (right.width * right.height) - (left.width * left.height))[0];
  if (!scrollBounds) return 0;
  const elements = result.elements || [];
  const modeList = elements.find((element) => (
    ['list', 'grouped-list', 'swipe-list', 'expandable-list'].includes(element.elementType)
      && /会议模式/.test(String(element.label || ''))
  ));
  if (!modeList) return 0;
  const fixedKeys = new Set(elements
    .filter((element) => (element.riskSignals || []).includes('fixed-position'))
    .map((element) => element.candidateKey));
  const modeCards = elements.filter((element) => {
    if (element.elementType !== 'card' || !/模式/.test(String(element.label || ''))) return false;
    const region = element.approximateRegion;
    if (!region) return false;
    const overlapWidth = Math.max(0, Math.min(region.x + region.width, scrollBounds.x + scrollBounds.width)
      - Math.max(region.x, scrollBounds.x));
    const overlapHeight = Math.max(0, Math.min(region.y + region.height, scrollBounds.y + scrollBounds.height)
      - Math.max(region.y, scrollBounds.y));
    return overlapWidth * overlapHeight > 0;
  });
  let repaired = 0;
  const relationExists = (fromCandidateKey, toCandidateKey) => (result.relationships || []).some((relation) => (
    relation.type === 'contains'
      && relation.fromCandidateKey === fromCandidateKey
      && relation.toCandidateKey === toCandidateKey
  ));
  for (const card of modeCards) {
    if (!relationExists(modeList.candidateKey, card.candidateKey)) {
      result.relationships = result.relationships || [];
      result.relationships.push({ fromCandidateKey: modeList.candidateKey, type: 'contains', toCandidateKey: card.candidateKey });
      repaired += 1;
    }
  }
  const modeKeys = new Set(modeCards.map((element) => element.candidateKey));
  result.relationships = (result.relationships || []).filter((relation) => (
    relation.type !== 'contains'
      || !(modeKeys.has(relation.fromCandidateKey) && fixedKeys.has(relation.toCandidateKey))
  ));
  return repaired;
}

function correctFullPageOffscreenGeometryFromOcr(result, runtimeStructure, ocrTextSources, viewport) {
  const hierarchy = runtimeStructure?.hierarchy || runtimeStructure;
  if (!isFullPageScreenshot(hierarchy, viewport) || ocrTextSources.length === 0) return 0;
  const scrollNode = flatten(hierarchy?.root)
    .filter((node) => node?.scrollable && node.bounds)
    .sort((left, right) => areaFromBounds(right.bounds) - areaFromBounds(left.bounds))[0];
  if (!scrollNode?.bounds || !viewport?.height) return 0;
  const offscreenStart = Number(scrollNode.bounds.bottom) / viewport.height;
  const fixedBoxes = fixedRuntimeBoxes(runtimeStructure, viewport);
  const sameRuntimeRegion = (region, box) => (
    normalizedBoxCoverage(region, box) >= 0.6
      && normalizedBoxCoverage(box, region) >= 0.6
  );
  const isFixedElement = (element) => {
    const regions = (element.abstraction?.instanceRegions?.length
      ? element.abstraction.instanceRegions
      : [element.approximateRegion]).filter(Boolean);
    return regions.length > 0 && regions.every((region) => fixedBoxes.some((box) => sameRuntimeRegion(region, box)));
  };
  const scrollElements = (result.elements || []).filter((element) => (
    element.approximateRegion
      && element.approximateRegion.y >= offscreenStart - 0.005
      && !isFixedElement(element)
  ));
  const anchors = [];
  const usedSources = new Set();
  for (const element of scrollElements) {
    if (!(TEXT_TYPES.has(element.elementType) || TITLE_TEXT_TYPES.has(element.elementType))) continue;
    const candidates = ocrTextSources.map((source, index) => {
      if (usedSources.has(index) || source.box.y < offscreenStart - 0.02) return null;
      const score = Math.max(0, ...semanticTerms(element).map((term) => textScore(term, source.text)));
      if (score < 0.82) return null;
      const proximity = Math.abs(center(element.approximateRegion).y - center(source.box).y);
      return { source, index, score, rank: score - Math.min(proximity, 0.5) * 0.1 };
    }).filter(Boolean).sort((left, right) => right.rank - left.rank);
    const match = candidates[0];
    if (!match) continue;
    const delta = center(match.source.box).y - center(element.approximateRegion).y;
    if (Math.abs(delta) > 0.08) continue;
    usedSources.add(match.index);
    anchors.push({ y: center(element.approximateRegion).y, delta });
  }
  if (anchors.length < 2) return 0;
  anchors.sort((left, right) => left.y - right.y);
  const offsetAt = (y) => {
    if (y <= anchors[0].y) return anchors[0].delta;
    if (y >= anchors.at(-1).y) return anchors.at(-1).delta;
    const upperIndex = anchors.findIndex((anchor) => anchor.y >= y);
    const lower = anchors[Math.max(0, upperIndex - 1)];
    const upper = anchors[upperIndex];
    const span = Math.max(0.000001, upper.y - lower.y);
    const ratio = (y - lower.y) / span;
    return lower.delta + (upper.delta - lower.delta) * ratio;
  };
  const correctBox = (box) => box && box.y >= offscreenStart - 0.005
    ? clampBox({ ...box, y: box.y + offsetAt(center(box).y) })
    : box;
  for (const element of scrollElements) {
    element.approximateRegion = correctBox(element.approximateRegion);
    if (element.abstraction) {
      element.abstraction.instanceRegions = (element.abstraction.instanceRegions || []).map(correctBox);
      for (const field of element.abstraction.fields || []) {
        field.instanceRegions = (field.instanceRegions || []).map(correctBox);
      }
    }
    element.riskSignals = [...new Set([
      ...(element.riskSignals || []),
      'geometry-corrected-by-full-page-ocr',
    ])];
  }
  return scrollElements.length;
}

function areaFromBounds(bounds) {
  return Math.max(0, Number(bounds?.right) - Number(bounds?.left))
    * Math.max(0, Number(bounds?.bottom) - Number(bounds?.top));
}

function downgradeUnstructuredDynamicTitles(result) {
  let count = 0;
  for (const element of result.elements || []) {
    if (element?.elementType !== 'title' || element.dynamicContent !== true || element.interactive) continue;
    // Semantic inference is allowed to preserve a single text field when the
    // page context identifies it as a runtime business title (for example a
    // person's daily report). Geometry refinement must never erase that
    // decision merely because the slot has no avatar or sibling field.
    if (hasBusinessDynamicSemantics(element)) continue;
    const abstraction = element.abstraction;
    const fields = abstraction?.fields || [];
    const unstructured = !abstraction || (
      abstraction.kind === 'dynamic-template'
      && fields.length <= 1
      && fields.every((field) => (
        TITLE_TEXT_TYPES.has(field.elementType)
          && (field.capabilities || []).every((capability) => capability === 'none')
      ))
    );
    if (!unstructured) continue;
    element.dynamicContent = false;
    element.abstraction = null;
    element.riskSignals = [...new Set([...(element.riskSignals || []), 'unstructured-dynamic-title-downgraded'])];
    count += 1;
  }
  return count;
}

export function refineRecognitionGeometryWithSources(recognitionResult, runtimeStructure, ocr = null, screenshot = null, pageContext = '') {
  const result = structuredClone(recognitionResult);
  const hierarchy = runtimeStructure?.hierarchy || runtimeStructure;
  const dom = runtimeStructure?.dom || null;
  applyBusinessDynamicSemantics(result, pageContext);
  const dynamicTitleDowngradeCount = downgradeUnstructuredDynamicTitles(result);
  // Full-page captures retain display-pixel positions but are taller than the
  // device viewport. Normalize runtime and DOM bounds against the captured
  // image so the frontend viewport mask remains display-only.
  const coordinateViewport = screenshot?.width && screenshot?.height
    ? { width: screenshot.width, height: screenshot.height }
    : hierarchy?.viewport;
  // Older runs could have promoted a clickable full-surface UI root to an
  // icon-button. Remove that generated artifact before geometry is displayed,
  // including when a previously persisted result is reprocessed.
  const removedRuntimeRoots = new Set((result.elements || [])
    .filter((element) => element?.candidateKey?.startsWith('runtime_')
      && element.label === 'root'
      && element.elementType === 'icon-button'
      && (element.approximateRegion?.width || 0) >= 0.8
      && (element.approximateRegion?.height || 0) >= 0.15)
    .map((element) => element.candidateKey));
  if (removedRuntimeRoots.size > 0) {
    result.elements = (result.elements || []).filter((element) => !removedRuntimeRoots.has(element.candidateKey));
    result.relationships = (result.relationships || []).filter((relation) => (
      !removedRuntimeRoots.has(relation.fromCandidateKey) && !removedRuntimeRoots.has(relation.toCandidateKey)
    ));
    result.actionCandidates = (result.actionCandidates || []).filter((action) => !removedRuntimeRoots.has(action.triggerCandidateKey));
  }
  const ocrTextSources = ocrSources(ocr, screenshot);
  const ocrStructuralSources = ocrSources(ocr, screenshot, 1);
  // Deduplicate inner/outer outlines locally. Repeated controls are aligned
  // later from their explicit template structure, never by transferring one
  // arbitrary rectangle's inset to another screen region.
  const rectangleSources = calibratedVisionRectangleSources(visionRectangleSources(ocr, screenshot));
  const separatorSources = separatorBandSources(ocr, screenshot);
  const runtimeTextSources = runtimeAnchorSources(hierarchy, dom, coordinateViewport);
  const runtimePlaceholderTextSources = runtimePlaceholderSources(hierarchy, coordinateViewport);
  const sources = mergeAnchorSources([...runtimeTextSources, ...ocrTextSources]);
  const anchors = calibrationAnchors(result.elements || [], sources);
  const calibration = { x: fitAxis(anchors, 'x'), y: fitAxis(anchors, 'y') };
  // When the screenshot and UI tree share the same display aspect, their
  // normalized coordinates already describe the same space. Applying a
  // text-anchor fit globally in that case can move otherwise-correct icon and
  // tap-target boxes that have no textual anchor of their own.
  const coordinateSpaceAligned = screenshotCoordinatesAligned(hierarchy, screenshot);
  const fullPageScreenshot = isFullPageScreenshot(hierarchy, screenshot);
  // A hybrid full-page image and the model output already share the image's
  // coordinate space. Runtime text anchors are still useful for matching and
  // exact control bounds, but a best-fit transform over the whole result would
  // apply small viewport-vs-image differences to every abstract instance and
  // visibly compress otherwise-correct templates.
  const calibrationReliable = !fullPageScreenshot
    && !coordinateSpaceAligned
    && (calibration.y.reliable || calibration.x.reliable);
  const applicableCalibration = {
    x: calibration.x.reliable ? calibration.x : { scale: 1, offset: 0 },
    y: calibration.y.reliable ? calibration.y : { scale: 1, offset: 0 },
  };
  // A model may emit the avatar and its visible name as separate candidates
  // on one retry and as one dynamic payload on another. Reconcile that shape
  // from the frozen runtime image/text evidence before exact matching so the
  // remainder of the refinement pass sees one stable candidate set.
  const runtimeAvatarNameMergeCount = mergeRuntimeAvatarNameCandidates(
    result,
    hierarchy,
    dom,
    coordinateViewport,
  );
  const exact = directMatches(result.elements || [], hierarchy, dom, coordinateViewport);
  const runtimeRectangles = runtimeInputRectangles(hierarchy, dom, coordinateViewport);
  const usedRuntimeRectangles = new Set();
  const usedTopLevelRectangles = new Set();
  let rectangleMatchCount = 0;
  let structuralFieldMatchCount = 0;
  let structuralFieldRegionCount = 0;
  let runtimeSupplementCount = 0;
  const runtimeSupplementMetrics = {};
  let runtimeInputMatchCount = 0;
  let recoveredSemanticContainerCount = 0;
  const repeatedRuntimeGroundedElements = new Set();

  // Models may emit repeated input controls as unrelated top-level elements.
  // Reattach those controls before any abstract-field grounding so the
  // repeated template remains the source of truth for its field structure.
  ensureRepeatedTemplateInputFields(result.elements || []);
  // Runtime/DOM expose one concrete rectangle per repeated row/card. Ground
  // those rectangles before matching abstract fields so row-local text
  // assignment and every field instance share the same authoritative axis.
  const repeatedRuntimeMatchCount = groundRepeatedTemplateInstances(
    result,
    hierarchy,
    dom,
    coordinateViewport,
    repeatedRuntimeGroundedElements,
  );
  // Avatar candidates are frequently serialized as the whole horizontal
  // recipient row (or as an accessibility wrapper) instead of the actual
  // image.  Use the concrete runtime image as the authoritative visual
  // boundary for standalone avatar/avatar-group elements. Dynamic-template
  // parents are handled below together with their fields so their combined
  // outer box remains the union of all observed slots.
  const standaloneAvatarGroundingCount = groundStandaloneAvatarElements(
    result,
    hierarchy,
    dom,
    coordinateViewport,
  );

  for (const element of result.elements || []) {
    const matched = exact.get(element.candidateKey);
    if (matched) {
      element.approximateRegion = matched.box;
      // A single-instance textual dynamic template (for example, a title
      // whose value is the current user's name) must follow the exact runtime
      // node just like its concrete element. Otherwise the stale model
      // instance region can still paint across an adjacent control.
      if (element.abstraction?.kind === 'dynamic-template'
        && element.abstraction.instanceRegions?.length === 1
        && TEXT_TYPES.has(element.elementType)) {
        element.abstraction.instanceRegions = [matched.box];
        for (const field of element.abstraction.fields || []) {
          if (field.instanceRegions?.length === 1 && TEXT_TYPES.has(field.elementType)) field.instanceRegions = [matched.box];
        }
      }
      // Runtime bounds are authoritative, but the interaction semantics still
      // come from the candidate unless the runtime node explicitly proves that
      // the visible control is interactive. WebView labels frequently omit the
      // native input node, so an interactive DOM label/span must be allowed to
      // recover the checkbox/button semantics the model missed.
      const runtimeInteractive = Boolean(matched.interactive || matched.clickable || matched.focusable
        || matched.checkable || matched.role === 'button' || matched.role === 'checkbox'
        || matched.type === 'checkbox');
      const interactiveElement = Boolean(element.interactive || runtimeInteractive);
      if (runtimeInteractive && (BUTTON_TYPES.has(element.elementType)
        || ['checkbox', 'switch', 'radio', 'dropdown-selector', 'tag-selector', 'segmented-selector'].includes(element.elementType))) {
        element.interactive = true;
      }
      element.geometryKind = interactiveElement && (BUTTON_TYPES.has(element.elementType)
        || ['checkbox', 'switch', 'radio', 'dropdown-selector', 'tag-selector', 'segmented-selector'].includes(element.elementType))
        ? 'tap-target'
        : 'boundary';
      element.geometryConfidence = matched.confidence;
      element.riskSignals = [...new Set([...(element.riskSignals || []), 'geometry-grounded-by-runtime', groundingSignal(matched.source)])];
      continue;
    }
    const runtimeInputRectangle = bestRuntimeInputRectangle(element, runtimeRectangles, usedRuntimeRectangles);
    if (runtimeInputRectangle) {
      usedRuntimeRectangles.add(runtimeInputRectangle.sourceRectangle);
      element.approximateRegion = runtimeInputRectangle.box;
      element.geometryKind = 'boundary';
      element.geometryConfidence = 0.99;
      element.riskSignals = [...new Set([...(element.riskSignals || []), 'geometry-grounded-by-runtime', groundingSignal(runtimeInputRectangle.source)])];
      runtimeInputMatchCount += 1;
      continue;
    }
    const inputRectangle = bestInputRectangle(element, rectangleSources, ocrTextSources, usedTopLevelRectangles);
    if (inputRectangle) {
      usedTopLevelRectangles.add(inputRectangle.sourceRectangle);
      element.approximateRegion = inputRectangle.box;
      element.geometryKind = 'boundary';
      element.geometryConfidence = Math.max(0.88, Math.min(0.97, inputRectangle.confidence));
      element.riskSignals = [...new Set([...(element.riskSignals || []), 'geometry-grounded-by-vision-rectangle'])];
      rectangleMatchCount += 1;
      continue;
    }
    if (calibrationReliable) {
      transformElementRegions(element, applicableCalibration);
      element.geometryConfidence = Math.max(Math.min(Number(element.geometryConfidence) || 0.5, 0.92), 0.85);
      element.riskSignals = [...new Set([...(element.riskSignals || []), 'geometry-calibrated-by-text-anchors'])];
    } else {
      element.geometryConfidence = Math.min(Number(element.geometryConfidence) || 0.5, 0.65);
      element.riskSignals = [...new Set([...(element.riskSignals || []), 'geometry-remains-approximate'])];
    }
    if (TEXT_TYPES.has(element.elementType) || element.elementType === 'text-button') {
      const match = bestTextMatch(element, ocrTextSources, () => true);
      // OCR confidence can be low when a button combines an icon and text
      // (or touches a neighboring control). A strong lexical match is still
      // better than retaining a model-estimated button box.
      if (match && match.confidence >= 0.3 && match.textScore >= 0.78) {
        if (element.elementType === 'text-button') {
          const expanded = expandedTextButtonBox(match.box, ocr, screenshot);
          element.approximateRegion = clipTextButtonAtAdjacentControls(expanded, element, result.elements);
        } else {
          element.approximateRegion = match.box;
        }
        element.geometryKind = element.elementType === 'text-button' ? 'tap-target' : 'boundary';
        element.geometryConfidence = Math.max(0.88, Math.min(0.96, match.confidence));
        element.riskSignals = [...new Set([...(element.riskSignals || []), 'geometry-grounded-by-ocr'])];
        if (element.elementType === 'text-button') {
          element.riskSignals = [...new Set([...(element.riskSignals || []), 'geometry-tap-target-expanded-from-ocr'])];
        }
      }
    }
    // Abstract input instances must be grounded last. Otherwise a reliable
    // global text calibration would transform these already-exact screenshot
    // rectangles a second time.
    const abstractRectangleGrounding = groundAbstractInputFields(element, rectangleSources);
    // Apply UI Automation/DOM input bounds after OCR. Runtime controls are
    // exact display coordinates and must not be overwritten by a visual
    // rectangle that was inferred in a different coordinate space.
    const runtimeInputGrounding = groundAbstractInputFieldsFromRuntime(element, runtimeInputRectangles(hierarchy, dom, coordinateViewport));
    if (runtimeInputGrounding > 0) {
      runtimeInputMatchCount += runtimeInputGrounding;
      element.geometryConfidence = Math.max(Number(element.geometryConfidence) || 0.5, 0.99);
      element.riskSignals = [...new Set([...(element.riskSignals || []), 'geometry-grounded-by-ui-tree', 'geometry-grounded-by-runtime'])];
    }
    const structuralTextSources = mergeAnchorSources([
      ...runtimeTextSources,
      ...runtimePlaceholderTextSources,
      ...ocrStructuralSources,
    ]);
    const restoredStructuralFields = restoreFormTemplateStructuralFields(element, structuralTextSources);
    const abstractTextMatches = groundAbstractTextFields(element, mergeAnchorSources([...runtimeTextSources, ...ocrTextSources]));
    const inputInstanceCount = (element.abstraction?.fields || [])
      .filter((field) => INPUT_TYPES.has(field.elementType))
      .reduce((count, field) => Math.max(count, field.instanceRegions?.length || 0), 0);
    const allInputsGrounded = inputInstanceCount > 0
      && runtimeInputGrounding + abstractRectangleGrounding.count >= inputInstanceCount;
    if (abstractTextMatches > 0 || allInputsGrounded) {
      recomputeAbstractInstanceRegions(element);
      rebuildRepeatedFormBoundaries(element);
      element.geometryConfidence = Math.max(Number(element.geometryConfidence) || 0.5, 0.88);
      element.riskSignals = [...new Set([...(element.riskSignals || []), abstractTextMatches > 0 ? 'geometry-grounded-by-ocr' : 'geometry-grounded-by-runtime'])];
    }
    if (abstractRectangleGrounding.count > 0) {
      rectangleMatchCount += abstractRectangleGrounding.count;
      element.geometryConfidence = Math.max(Number(element.geometryConfidence) || 0.5, 0.88);
      element.riskSignals = [...new Set([...(element.riskSignals || []), 'geometry-grounded-by-vision-rectangle'])];
    }
    // Separator-derived block containers are the outermost visual boundary,
    // so apply them after child fields have been grounded and recomputed.
    const visualBlocks = deriveVisualRepeatedBlockRegions(element, separatorSources);
    const completedInputRegions = completeRepeatedInputGeometry(element, abstractRectangleGrounding.matchesByField);
    structuralFieldMatchCount += restoredStructuralFields.fieldCount;
    structuralFieldRegionCount += restoredStructuralFields.regionCount;
    if (visualBlocks.count > 0) {
      element.approximateRegion = abstractBoundingBox(element) || element.approximateRegion;
      element.geometryConfidence = Math.max(Number(element.geometryConfidence) || 0.5, 0.92);
      element.riskSignals = [...new Set([...(element.riskSignals || []), 'geometry-grounded-by-visual-separation', 'geometry-grounded-by-visual-separator'])];
      if (visualBlocks.partialCount > 0) {
        element.riskSignals = [...new Set([...(element.riskSignals || []), 'last-repeated-block-partially-visible'])];
      }
    }
    if (completedInputRegions > 0) {
      element.riskSignals = [...new Set([...(element.riskSignals || []), 'geometry-completed-from-repeated-structure'])];
    }
    if (restoredStructuralFields.fieldCount > 0) {
      element.riskSignals = [...new Set([...(element.riskSignals || []), 'structural-fields-grounded-by-ocr'])];
    }
  }
  // Runtime structure is authoritative for visible node existence. Calibrate
  // semantic section boundaries before supplementing nodes so oversized model
  // boxes cannot swallow the next section's controls. Split dynamic payloads
  // before coverage checks so a container's abstraction is not treated
  // as a missing top-level child.
  const formContainerMatchCount = calibrateFormContainerBounds(result, hierarchy, dom, coordinateViewport);
  recoveredSemanticContainerCount = recoverMissingSemanticContainers(result, hierarchy, dom, coordinateViewport);
  const semanticContainerMatchCount = calibrateSemanticContainerBounds(result, hierarchy, dom, coordinateViewport);
  removeSyntheticContainerLabelDuplicates(result);
  ensureSemanticHierarchy(result, { preserveContainerGeometry: fullPageScreenshot });
  runtimeSupplementCount = supplementMissingRuntimeElements(
    result,
    hierarchy,
    dom,
    coordinateViewport,
    runtimeSupplementMetrics,
  );
  // Supplementation can add concrete children and therefore changes the set of
  // candidates used by the relationship repair pass.
  ensureSemanticHierarchy(result, { preserveContainerGeometry: fullPageScreenshot });
  pruneDanglingRelationships(result);
  // Hierarchy repair can expand a section around stale model geometry. Re-read
  // the semantic section bounds from the runtime tree, then only tighten
  // dynamic children to those authoritative owner boundaries.
  const finalSemanticContainerMatchCount = calibrateSemanticContainerBounds(result, hierarchy, dom, coordinateViewport);
  let dynamicContainmentPruneCount = pruneDynamicContainmentToOwners(result);
  const dynamicChildGroundingCount = groundDynamicChildren(result, hierarchy, dom, coordinateViewport);
  // Grounded dynamic fields are stronger evidence than a stale outer payload
  // rectangle. Expand only their resolved owner, capped at the next sibling
  // boundary, before clipping the child fields to that owner.
  const dynamicOwnerExpansionCount = expandOwnersFromGroundedDynamicFields(result);
  // Runtime grounding can move a stale dynamic box into a more specific
  // semantic container. Resolve ownership again from the grounded geometry
  // before clipping, then enforce the same invariant on the final boxes.
  dynamicContainmentPruneCount += pruneDynamicContainmentToOwners(result);
  const dynamicChildClipCount = clipDynamicChildrenToOwners(result);
  dynamicContainmentPruneCount += pruneDynamicContainmentToOwners(result);
  // Keep only direct semantic containment. Without this pass an outer form
  // and an inner section both claim the same child, and draft merge's
  // last-write-wins behavior makes the outer form the apparent parent.
  pruneTransitiveContainment(result);
  pruneOutOfBoundsContainment(result);
  // Text/OCR grounding runs after the initial repeated-card calibration. Keep
  // row fields inside their authoritative runtime item, then re-assert the
  // outer union so later generic container repair cannot reintroduce a stale
  // model right edge.
  for (const element of repeatedRuntimeGroundedElements) {
    keepRepeatedFieldsInsideInstances(element);
    element.approximateRegion = abstractBoundingBox(element) || element.approximateRegion;
  }
  const repeatedListContainerMatchCount = calibrateRepeatedListContainerBounds(result);
  pruneOutOfBoundsContainment(result);
  // A stale run can leave one navigation candidate with a full-page/content
  // rectangle even after all child grounding has completed. Re-run the
  // runtime-band check at the end so the final payload is self-consistent
  // before navigation deduplication and relationship serialization.
  const navigationCalibrationCount = calibrateNavigationContainerBounds(
    result,
    hierarchy,
    dom,
    coordinateViewport,
  );
  pruneOutOfBoundsContainment(result);
  // Remove only geometrically overlapping navigation candidates after all
  // runtime grounding and relationship repair has settled their boundaries.
  // Separate top/bottom bars remain valid because their vertical intervals do
  // not overlap.
  const navigationDedupCount = deduplicateNavigationBars(result);
  const fullPageOcrCorrectionCount = correctFullPageOffscreenGeometryFromOcr(
    result,
    runtimeStructure,
    ocrTextSources,
    coordinateViewport,
  );
  const fixedPositionElementCount = markFixedPositionElements(result, runtimeStructure, coordinateViewport);
  pruneCrossPositionContainment(result);
  const scrollContainmentRepairCount = repairRuntimeScrollableContainment(result, runtimeStructure, coordinateViewport);
  result.geometryRefinement = {
    version: 2,
    uiTreeAvailable: Boolean(hierarchy?.root),
    domStatus: dom?.status || 'unavailable',
    ocrStatus: ocr?.status || 'unavailable',
    ocrEngine: ocr?.engine || null,
    anchorCount: anchors.length,
    calibration: {
      x: calibration.x,
      y: calibration.y,
      reliable: calibrationReliable,
    },
    fullPageScreenshot,
    exactMatchCount: exact.size,
    rectangleMatchCount,
    separatorBandCount: separatorSources.length,
    structuralFieldMatchCount,
    structuralFieldRegionCount,
    runtimeInputMatchCount,
    runtimeSupplementCount,
    runtimeRepeatedGroupCount: runtimeSupplementMetrics.repeatedGroupCount || 0,
    recoveredSemanticContainerCount,
    semanticContainerMatchCount: semanticContainerMatchCount + finalSemanticContainerMatchCount,
    formContainerMatchCount,
    dynamicContainmentPruneCount,
    dynamicChildGroundingCount,
    dynamicOwnerExpansionCount,
    dynamicChildClipCount,
    dynamicTitleDowngradeCount,
    repeatedRuntimeMatchCount,
    repeatedListContainerMatchCount,
    navigationCalibrationCount,
    navigationDedupCount,
    fullPageOcrCorrectionCount,
    fixedPositionElementCount,
    scrollContainmentRepairCount,
    standaloneAvatarGroundingCount,
    runtimeAvatarNameMergeCount,
    visualBlockMatchCount: (result.elements || []).reduce((count, element) => (
      count + ((element.riskSignals || []).includes('geometry-grounded-by-visual-separation')
        ? (element.abstraction?.instanceRegions?.length || 0)
        : 0)
    ), 0),
  };
  return result;
}

export async function refineRecognitionGeometry(recognitionResult, frozenFrame, pageContext = '') {
  const ocr = await recognizeScreenshotText(frozenFrame?.imagePath);
  return refineRecognitionGeometryWithSources(
    recognitionResult,
    frozenFrame?.runtimeStructure,
    ocr,
    { width: frozenFrame?.width, height: frozenFrame?.height },
    pageContext,
  );
}
