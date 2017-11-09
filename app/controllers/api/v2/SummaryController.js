import { dbAdapter } from '../../../models'
import { NotFoundException } from '../../../support/exceptions'
import { serializePostsCollection } from '../../../serializers/v2/post';
import { monitored, authRequired } from './helpers';

const getDays = (d) => {
  const DEFAULT_DAYS = 7;
  const MIN_DAYS = 1;
  const MAX_DAYS = 30;
  const days = parseInt(d, 10) || DEFAULT_DAYS;
  return Math.max(MIN_DAYS, Math.min(MAX_DAYS, days));
};

export default class SummaryController {
  static generalSummary = authRequired(monitored('summary.general', async (ctx) => {
    const days = getDays(ctx.params.days);

    const currentUser = ctx.state.user;

    // Get timeline "RiverOfNews" of current user
    const [timelineIntId] = await dbAdapter.getUserNamedFeedsIntIds(currentUser.id, ['RiverOfNews']);

    // Get posts current user subscribed to
    const foundPosts = await dbAdapter.getSummaryPosts(currentUser.id, timelineIntId, days);

    const postsObjects = dbAdapter.initRawPosts(foundPosts, { currentUser: currentUser.id });

    ctx.body = await serializePostsCollection(postsObjects, currentUser.id);
  }));

  static userSummary = monitored('summary.user', async (ctx) => {
    const { username } = ctx.params;
    const targetUser = await dbAdapter.getFeedOwnerByUsername(username);

    if (targetUser === null) {
      throw new NotFoundException(`Feed "${username}" is not found`);
    }

    const days = getDays(ctx.params.days);

    const currentUserId = ctx.state.user ? ctx.state.user.id : null;

    // Get timeline "Posts" of target user
    const [timelineIntId] = await dbAdapter.getUserNamedFeedsIntIds(targetUser.id, ['Posts']);

    // Get posts authored by target user, and provide current user (the reader) for filtering
    const foundPosts = await dbAdapter.getSummaryPosts(currentUserId, timelineIntId, days);

    const postsObjects = dbAdapter.initRawPosts(foundPosts, { currentUser: currentUserId });

    ctx.body = await serializePostsCollection(postsObjects, currentUserId);
  });
}
