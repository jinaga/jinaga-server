import { buildModel, PurgeConditions, User } from "jinaga";

export class Site {
    static Type = 'Blog.Site' as const;
    type = Site.Type;

    constructor(
        public readonly creator: User,
        public readonly domain: string
    ) { }
}

export class SiteDeleted {
    static Type = 'Blog.Site.Deleted' as const;
    type = SiteDeleted.Type;

    constructor(
        public readonly site: Site
    ) { }
}

export class Post {
    static Type = 'Blog.Post' as const;
    type = Post.Type;

    constructor(
        public readonly site: Site,
        public readonly createdAt: Date | string
    ) { }
}

export class PostDeleted {
    static Type = 'Blog.Post.Deleted' as const;
    type = PostDeleted.Type;

    constructor(
        public readonly post: Post
    ) { }
}

export class Title {
    static Type = 'Blog.Post.Title' as const;
    type = Title.Type;

    constructor(
        public readonly post: Post,
        public readonly value: string,
        public readonly prior: Title[]
    ) { }
}

export const model = buildModel(b => b
    .type(Site, f => f
        .predecessor('creator', User)
    )
    .type(Post, f => f
        .predecessor('site', Site)
    )
    .type(SiteDeleted, f => f
        .predecessor('site', Site)
    )
    .type(Title, f => f
        .predecessor('post', Post)
        .predecessor('prior', Title)
    )
    .type(PostDeleted, f => f
        .predecessor('post', Post)
    )
)

export const purgeConditions = (p: PurgeConditions) => p
    .whenExists(model.given(Site).match((site, facts) =>
        facts.ofType(SiteDeleted)
            .join(deleted => deleted.site, site)
    ))
    .whenExists(model.given(Post).match((post, facts) =>
        facts.ofType(PostDeleted)
            .join(deleted => deleted.post, post)
    ))
    ;