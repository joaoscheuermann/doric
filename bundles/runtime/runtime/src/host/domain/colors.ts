import { type ProjectColor, projectColors } from '../../contracts/model.js';

/** Picks the color a new Project is marked with. */
export const randomProjectColor = (): ProjectColor =>
  projectColors[Math.floor(Math.random() * projectColors.length)];
