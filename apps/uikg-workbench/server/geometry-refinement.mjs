import { recognizeScreenshotText } from './vision-ocr.mjs';

const CONTAINER_TYPES = new Set([
  'navigation-bar', 'sidebar', 'drawer', 'list', 'grouped-list', 'swipe-list',
  'expandable-list', 'card', 'panel', 'section', 'form', 'table', 'status-bar',
]);
const TEXT_TYPES = new Set(['title', 'static-label', 'badge', 'status', 'breadcrumb', 'link']);
const INPUT_TYPES = new Set(['input', 'text-area', 'rich-text-input']);
const BUTTON_TYPES = new Set(['text-button', 'icon-button', 'floating-button']);

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
      .flatMap((field) => field.instanceRegions || []);
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
  if (BUTTON_TYPES.has(element.elementType)) return Boolean(node.clickable) || /Button/i.test(className);
  return TEXT_TYPES.has(element.elementType);
}

function domTypeCompatible(element, node) {
  if (INPUT_TYPES.has(element.elementType)) return ['input', 'textarea'].includes(node.tag) || ['textbox', 'searchbox'].includes(node.role);
  if (element.elementType === 'checkbox') return node.type === 'checkbox' || node.role === 'checkbox';
  if (element.elementType === 'switch') return node.role === 'switch';
  if (element.elementType === 'radio') return node.type === 'radio' || node.role === 'radio';
  if (BUTTON_TYPES.has(element.elementType)) return node.interactive || node.role === 'button';
  return TEXT_TYPES.has(element.elementType);
}

function bestTextMatch(element, sources, compatible) {
  const terms = semanticTerms(element);
  const regions = allModelRegions(element);
  let best = null;
  for (const source of sources) {
    if (!source.box || !compatible(element, source)) continue;
    const score = Math.max(0, ...terms.map((term) => textScore(term, source.text)));
    if (score < 0.78) continue;
    const proximity = Math.min(...regions.map((region) => distance(center(region), center(source.box))));
    const rank = score - Math.min(proximity, 1) * 0.12;
    if (!best || rank > best.rank) best = { ...source, rank, textScore: score };
  }
  return best;
}

function directMatches(elements, hierarchy, dom) {
  const viewport = hierarchy?.viewport;
  const uiSources = flatten(hierarchy?.root).filter((node) => node.bounds).map((node) => ({
    ...node,
    text: node.text || node.contentDescription || '',
    box: normalizedDisplayBounds(node.bounds, viewport),
  })).filter((node) => node.box);
  const domSources = (dom?.documents || []).flatMap((document) => (document.nodes || []).map((node) => ({
    ...node,
    box: normalizedDisplayBounds(node.bounds, document.displayViewport || viewport),
  }))).filter((node) => node.box);
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
    const domMatch = bestTextMatch(element, domSources, domTypeCompatible);
    if (domMatch) {
      matches.set(element.candidateKey, { ...domMatch, source: 'dom', confidence: 0.99 });
      continue;
    }
    const uiMatch = bestTextMatch(element, uiSources, uiTypeCompatible);
    if (uiMatch) matches.set(element.candidateKey, { ...uiMatch, source: 'ui-tree', confidence: 0.98 });
  }
  return matches;
}

function runtimeAnchorSources(hierarchy, dom) {
  const viewport = hierarchy?.viewport;
  const ui = flatten(hierarchy?.root).filter((node) => node.bounds && (node.text || node.contentDescription)).map((node) => ({
    text: node.text || node.contentDescription,
    confidence: 0.98,
    source: 'ui-tree',
    box: normalizedDisplayBounds(node.bounds, viewport),
  })).filter((node) => node.box);
  const domNodes = (dom?.documents || []).flatMap((document) => (document.nodes || []).filter((node) => node.text).map((node) => ({
    text: node.text,
    confidence: 0.99,
    source: 'dom',
    box: normalizedDisplayBounds(node.bounds, document.displayViewport || viewport),
  }))).filter((node) => node.box);
  return [...domNodes, ...ui];
}

function mergeAnchorSources(sources) {
  const merged = [];
  for (const source of sources.sort((left, right) => right.confidence - left.confidence)) {
    const duplicate = merged.some((candidate) => normalizedText(candidate.text) === normalizedText(source.text)
      && distance(center(candidate.box), center(source.box)) <= 0.025);
    if (!duplicate) merged.push(source);
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
  const inputRegions = (element.abstraction.fields || [])
    .filter((field) => INPUT_TYPES.has(field.elementType))
    .flatMap((field) => field.instanceRegions || []);
  for (const field of element.abstraction.fields || []) {
    if (!TEXT_TYPES.has(field.elementType) && field.elementType !== 'text-button') continue;
    // Form marker, ordinal, label and placeholder boxes are split from the
    // complete OCR title/input geometry below. Letting generic OCR matching
    // claim them first reintroduces merged title rows and cross-instance drift.
    if (structuralFieldRole(field)) continue;
    const regions = field.instanceRegions || [];
    const permitsInputInterior = /placeholder|占位|提示/.test(`${field.key || ''} ${field.label || ''} ${field.description || ''}`.toLowerCase());
    field.instanceRegions = (field.instanceRegions || []).map((region) => {
      const fieldTerms = semanticTerms({
        ...element,
        label: field.label,
        meaning: { evidence: { visibleTexts: field.visibleTexts || [] } },
      });
      const terms = regions.length >= 2 ? [...new Set([...fieldTerms, ...elementTerms])] : fieldTerms;
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
    });
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
  if (/\s/u.test(character)) return 0.35;
  if (/[*＊✱✳]/u.test(character)) return 0.55;
  if (/\p{P}/u.test(character)) return 0.45;
  if (/\p{Script=Han}/u.test(character)) return 1;
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
  return {
    source,
    markerText: markerRange ? text.slice(...markerRange) : null,
    markerBox: markerRange ? textRangeBox(source, ...markerRange) : null,
    ordinalText: ordinalRange ? text.slice(...ordinalRange) : null,
    ordinalBox: ordinalRange ? textRangeBox(source, ...ordinalRange) : null,
    labelText: text.slice(...labelRange),
    labelBox: textRangeBox(source, ...labelRange),
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
  if (repeated.length > 0) return repeated.map((candidate) => candidate.source.box);
  if (!existingPlaceholder) return [];
  return candidates.filter((candidate) => (existingPlaceholder.instanceRegions || []).some((region) => (
    distance(center(region), center(candidate.source.box)) <= 0.08
  ))).map((candidate) => candidate.source.box);
}

function restoreFormTemplateStructuralFields(element, textSources) {
  if (!isFormLikeRepeatedTemplate(element) || textSources.length === 0) return { fieldCount: 0, regionCount: 0 };
  const abstraction = element.abstraction;
  const instances = abstraction.instanceRegions || [];
  const fields = abstraction.fields || [];
  const inputField = fields.find((field) => INPUT_TYPES.has(field.elementType));
  if (!inputField || instances.length < 2) return { fieldCount: 0, regionCount: 0 };

  const existingByRole = new Map(fields.map((field) => [structuralFieldRole(field), field]).filter(([role]) => role));
  const genericTitleField = fields.find((field) => (
    (TEXT_TYPES.has(field.elementType) || field.elementType === 'text-button')
    && !structuralFieldRole(field)
  )) || existingByRole.get('field-label') || null;
  const parsedTitles = instances.map((instance, index) => {
    const expected = genericTitleField?.instanceRegions?.[index] || instance;
    return textSources.map(parseFormTitleSource).filter(Boolean).filter((parsed) => {
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
  if (parsedTitles.filter((parsed) => parsed?.ordinalBox).length < 2) return { fieldCount: 0, regionCount: 0 };

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

  const markerRegions = parsedTitles.map((parsed) => parsed?.markerBox).filter(Boolean);
  const ordinalRegions = parsedTitles.map((parsed) => parsed?.ordinalBox).filter(Boolean);
  const labelRegions = parsedTitles.map((parsed) => parsed?.labelBox).filter(Boolean);
  const visibleLabels = parsedTitles.map((parsed) => parsed?.labelText?.trim()).filter(Boolean);
  const placeholderRegions = repeatedPlaceholderRegions(
    inputField.instanceRegions || [],
    textSources,
    existingByRole.get('placeholder'),
  );
  const structural = [];
  if (markerRegions.length > 0) structural.push(staticStructuralField(existingByRole.get('required-marker'), {
    key: 'required-marker', label: '必填标记', description: '仅记录截图中实际可见的必填标记',
    displayCondition: '对应字段为必填且标记可见时显示', regions: markerRegions,
  }));
  if (ordinalRegions.length > 0) structural.push(staticStructuralField(existingByRole.get('ordinal'), {
    key: 'ordinal', label: '填写项序号', description: '区分重复表单字段实例的可见序号',
    displayCondition: '实例带可见序号时显示', regions: ordinalRegions,
  }));
  if (labelRegions.length > 0) structural.push(staticStructuralField(existingByRole.get('field-label'), {
    key: 'field-label', label: '字段标签',
    description: `各实例的可见字段标签：${visibleLabels.join('、')}`,
    displayCondition: '字段标签可见时显示', regions: labelRegions,
  }));
  if (placeholderRegions.length > 0) structural.push(staticStructuralField(existingByRole.get('placeholder'), {
    key: 'placeholder', label: '输入提示语', description: '输入框未填写时在框内显示的可见提示语',
    displayCondition: '输入框为空且提示语在截图中可见时显示', regions: placeholderRegions,
  }));

  const replaced = new Set([...existingByRole.values(), genericTitleField].filter(Boolean));
  const preserved = fields.filter((field) => !replaced.has(field) && !INPUT_TYPES.has(field.elementType));
  const inputFields = fields.filter((field) => INPUT_TYPES.has(field.elementType));
  abstraction.fields = [...structural, ...preserved, ...inputFields];
  return {
    fieldCount: structural.length,
    regionCount: structural.reduce((count, field) => count + field.instanceRegions.length, 0),
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
    instances[index] = clampBox({
      x: Math.min(left, previous?.x ?? left),
      y: Math.max(0, top - 0.01),
      width: Math.max(right, (previous?.x || 0) + (previous?.width || 0)) - Math.min(left, previous?.x ?? left),
      height: Math.min(1, bottom + 0.01) - Math.max(0, top - 0.01),
    });
  }
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
  element.abstraction.instanceRegions = (element.abstraction.instanceRegions || []).map((box) => transformBox(box, calibration));
  for (const field of element.abstraction.fields || []) {
    field.instanceRegions = (field.instanceRegions || []).map((box) => transformBox(box, calibration));
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

function groundingSignal(source) {
  if (source === 'dom') return 'geometry-grounded-by-dom';
  return 'geometry-grounded-by-ui-tree';
}

export function refineRecognitionGeometryWithSources(recognitionResult, runtimeStructure, ocr = null, screenshot = null) {
  const result = structuredClone(recognitionResult);
  const hierarchy = runtimeStructure?.hierarchy || runtimeStructure;
  const dom = runtimeStructure?.dom || null;
  const ocrTextSources = ocrSources(ocr, screenshot);
  const ocrStructuralSources = ocrSources(ocr, screenshot, 1);
  // Deduplicate inner/outer outlines locally. Repeated controls are aligned
  // later from their explicit template structure, never by transferring one
  // arbitrary rectangle's inset to another screen region.
  const rectangleSources = calibratedVisionRectangleSources(visionRectangleSources(ocr, screenshot));
  const separatorSources = separatorBandSources(ocr, screenshot);
  const sources = mergeAnchorSources([...runtimeAnchorSources(hierarchy, dom), ...ocrTextSources]);
  const anchors = calibrationAnchors(result.elements || [], sources);
  const calibration = { x: fitAxis(anchors, 'x'), y: fitAxis(anchors, 'y') };
  // When the screenshot and UI tree share the same display aspect, their
  // normalized coordinates already describe the same space. Applying a
  // text-anchor fit globally in that case can move otherwise-correct icon and
  // tap-target boxes that have no textual anchor of their own.
  const coordinateSpaceAligned = screenshotCoordinatesAligned(hierarchy, screenshot);
  const calibrationReliable = !coordinateSpaceAligned && (calibration.y.reliable || calibration.x.reliable);
  const applicableCalibration = {
    x: calibration.x.reliable ? calibration.x : { scale: 1, offset: 0 },
    y: calibration.y.reliable ? calibration.y : { scale: 1, offset: 0 },
  };
  const exact = directMatches(result.elements || [], hierarchy, dom);
  const usedTopLevelRectangles = new Set();
  let rectangleMatchCount = 0;
  let structuralFieldMatchCount = 0;
  let structuralFieldRegionCount = 0;

  // Models may emit repeated input controls as unrelated top-level elements.
  // Reattach those controls before any abstract-field grounding so the
  // repeated template remains the source of truth for its field structure.
  ensureRepeatedTemplateInputFields(result.elements || []);

  for (const element of result.elements || []) {
    const matched = exact.get(element.candidateKey);
    if (matched) {
      element.approximateRegion = matched.box;
      element.geometryKind = 'boundary';
      element.geometryConfidence = matched.confidence;
      element.riskSignals = [...new Set([...(element.riskSignals || []), 'geometry-grounded-by-runtime', groundingSignal(matched.source)])];
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
    const restoredStructuralFields = restoreFormTemplateStructuralFields(element, ocrStructuralSources);
    const abstractTextMatches = groundAbstractTextFields(element, ocrTextSources);
    if (abstractTextMatches > 0) {
      recomputeAbstractInstanceRegions(element);
      element.geometryConfidence = Math.max(Number(element.geometryConfidence) || 0.5, 0.88);
      element.riskSignals = [...new Set([...(element.riskSignals || []), 'geometry-grounded-by-ocr'])];
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
    exactMatchCount: exact.size,
    rectangleMatchCount,
    separatorBandCount: separatorSources.length,
    structuralFieldMatchCount,
    structuralFieldRegionCount,
    visualBlockMatchCount: (result.elements || []).reduce((count, element) => (
      count + ((element.riskSignals || []).includes('geometry-grounded-by-visual-separation')
        ? (element.abstraction?.instanceRegions?.length || 0)
        : 0)
    ), 0),
  };
  return result;
}

export async function refineRecognitionGeometry(recognitionResult, frozenFrame) {
  const ocr = await recognizeScreenshotText(frozenFrame?.imagePath);
  return refineRecognitionGeometryWithSources(
    recognitionResult,
    frozenFrame?.runtimeStructure,
    ocr,
    { width: frozenFrame?.width, height: frozenFrame?.height },
  );
}
