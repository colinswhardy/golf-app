/** Stable natural-key slugs for courses. Bundled courses use the slug of their source filename
 * (see BUNDLED_COURSES in seedCourses.ts); ad-hoc imports slugify the OSM course name. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
