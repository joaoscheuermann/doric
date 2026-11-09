// The Appearance section is offered only while the app answers
// `doric.appearance/v1` (S35): an app before 1.3.0 has no provider, so the nav
// has no Appearance row and no route reaches the section.

import type {
  Disposable,
  Navigation,
  Regions,
  Services,
  Ui,
} from 'bundle/contracts';

import { AppearanceV1 } from './api/appearance.js';
import { sectionPath } from './domain/section-route.js';
import { sectionLink, sections } from './domain/sections.js';

export interface AppearanceSectionInput {
  readonly services: Pick<Services, 'whenAvailable'>;
  readonly ui: Pick<Ui, 'create'>;
  readonly navigation: Pick<Navigation, 'register'>;
  readonly regions: Pick<Regions, 'add'>;
}

/**
 * Registers the Appearance link in `settings.sections` and its
 * `/settings/appearance` route for as long as a `doric.appearance/v1`
 * provider exists; disposing the answer removes both.
 */
export const registerAppearanceSection = ({
  services,
  ui,
  navigation,
  regions,
}: AppearanceSectionInput): Disposable =>
  services.whenAvailable(AppearanceV1, () => {
    const appearance = sections.find((section) => section.id === 'appearance');
    if (appearance === undefined) return;

    const registrations = [
      navigation.register({
        path: sectionPath(appearance.id),
        parent: '/settings',
        create: () => ui.create(`settings-${appearance.id}`),
      }),
      regions.add('settings.sections', sectionLink(appearance)),
    ];

    return () => {
      for (const registration of registrations) registration.dispose();
    };
  });
