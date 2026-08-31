/** 内联的 jscanify 浏览器版(见同目录 jscanify.js)。只声明我们实际用到的两个方法。 */
export interface JscanifyCorners {
  topLeftCorner?: { x: number; y: number };
  topRightCorner?: { x: number; y: number };
  bottomRightCorner?: { x: number; y: number };
  bottomLeftCorner?: { x: number; y: number };
}
declare class Jscanify {
  findPaperContour(img: unknown): unknown;
  getCornerPoints(contour: unknown): JscanifyCorners;
}
export default Jscanify;
