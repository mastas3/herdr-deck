// Private sessions run in a throwaway folder named deck-private-<yyyymmdd><6 letters or digits> (the private-session
// plugin makes one). Their transcripts stay out of the history index and deep search, so paperwork done there never
// turns up in a search. Claude's project folder for one ends "…-deck-private-<id>", so the same test fits its paths.
export const PRIVATE_PREFIX = "deck-private-";
export const isPrivatePath = (p: string | undefined | null) => !!p && /(^|[\/-])deck-private-\d{8}[a-z0-9]{6}(?=$|[\/.-])/i.test(p);
