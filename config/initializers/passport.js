import { Strategy as LocalStrategy } from 'passport-local';
import FacebookStrategy from 'passport-facebook';
import GoogleStrategy from 'passport-google-oauth20';
import GithubStrategy from 'passport-github';
import { get, isString, isEmpty } from 'lodash';
import jwt from 'jsonwebtoken';

import { dbAdapter, User } from '../../app/models';
import { load as configLoader } from '../../config/config';
import { getLongLivedAccessToken } from '../../app/support/facebookGraphApi';


const config = configLoader();
const oauthConfig = config.oauth || {};

export function init(passport) {
  passport.use(new LocalStrategy({
    usernameField: 'username',
    passwordField: 'password'
  }, async (username, clearPassword, done) => {
    try {
      let user;

      if (username.indexOf('@') === -1) {
        user = await dbAdapter.getUserByUsername(username.trim());
      } else {
        user = await dbAdapter.getUserByEmail(username.trim());
      }

      if (!user) {
        // db inconsistency. got id, but didn't find object
        done({ message: 'We could not find the nickname you provided.' });
        return;
      }

      const valid = await user.validPassword(clearPassword);

      if (!valid) {
        done({ message: 'The password you provided does not match the password in our system.' });
        return;
      }

      done(null, user);
    } catch (e) {
      done({ message: 'We could not find the nickname you provided.' });
    }
  }));

  // Facebook
  if (!isEmpty(oauthConfig.facebookClientId)) {
    passport.use(new FacebookStrategy(
      {
        clientID:          oauthConfig.facebookClientId,
        clientSecret:      oauthConfig.facebookClientSecret,
        callbackURL:       `${config.host}/v2/oauth/facebook/callback`,
        profileFields:     ['id', 'displayName', 'name', 'profileUrl', 'emails', 'photos'],
        passReqToCallback: true,
        enableProof:       true,
      },
      getAuthenticationCallback('facebook')
    ));

    passport.use('facebook-authz', new FacebookStrategy(
      {
        clientID:          oauthConfig.facebookClientId,
        clientSecret:      oauthConfig.facebookClientSecret,
        callbackURL:       `${config.host}/v2/oauth/facebook/authz/callback`,
        profileFields:     ['id', 'displayName', 'name', 'profileUrl', 'emails', 'photos'],
        passReqToCallback: true,
        enableProof:       true,
      },
      facebookAuthzCallback
    ));
  }

  // Google
  // Enable Google+ api in app settings.
  if (!isEmpty(oauthConfig.googleClientId)) {
    passport.use(new GoogleStrategy(
      {
        clientID:          oauthConfig.googleClientId,
        clientSecret:      oauthConfig.googleClientSecret,
        callbackURL:       `${config.host}/v2/oauth/google/callback`,
        passReqToCallback: true,
      },
      getAuthenticationCallback('google')
    ));
  }

  // Github
  if (!isEmpty(oauthConfig.githubClientId)) {
    passport.use(new GithubStrategy(
      {
        clientID:          oauthConfig.githubClientId,
        clientSecret:      oauthConfig.githubClientSecret,
        callbackURL:       `${config.host}/v2/oauth/github/callback`,
        passReqToCallback: true,
      },
      getAuthenticationCallback('github')
    ));
  }
}

/**
 * Example:
 *  john.doe@gmail.com => johndoe{n}
 *  John Doe => JohnDoe{n}
 */
export async function generateUsername(myDbAdapter, { firstName, lastName, email, username }) {
  async function isUsernameInvalid(uncheckedUsername) {
    const user = await myDbAdapter.getUserByUsername(uncheckedUsername);

    if (
      user !== null ||
      User.stopList().includes(uncheckedUsername)
    ) {
      return true;
    }

    return false;
  }

  let generatedUsername;

  if (isString(username)) {
    generatedUsername = username;
  } else if (isString(email)) {
    // eslint-disable-next-line prefer-destructuring
    generatedUsername = email.split('@')[0];
  } else if (isString(firstName) && isString(lastName)) {
    generatedUsername = `${firstName}${lastName}`;
  } else {
    throw new Error(`Could not generate username`);
  }

  // Filter out all non-alphanumeric symbols
  generatedUsername = generatedUsername.replace(/\W/gi, '');

  // eslint-disable-next-line no-await-in-loop
  for (let n = 1, old = generatedUsername; await isUsernameInvalid(generatedUsername); ++n) {
    generatedUsername = `${old}${n}`;
  }

  return generatedUsername;
}

/**
 * Returns HTML with a script that posts a message to the parent window and closes the popup.
 */
export function renderCallbackResponse(props, origin = '*') {
  if (props.error && !isString(props.error)) {
    props.error = props.error.message;
  }

  return (`<!DOCTYPE html>
<html>
  <head>
    <script>
      window.opener.postMessage(${JSON.stringify(props)}, ${JSON.stringify(origin)});
      window.close();
    </script>
  </head>
</html>`
  );
}

/**
 * Returns a callback function for strategies.
 * Since passport-{provider} strategies accept callbacks with the same signature and the profile object
 * has the same structure across different providers, it's possible to write a generalized callback function.
 */
function getAuthenticationCallback(providerName) {
  return async function findOrCreateUser(req, token, tokenSecret, profile, done) {
    const origin = req.ctx.cookies.get('origin', { signed: true });
    const { user: currentUser } = req.ctx.state;

    if (currentUser) {
      try {
        await currentUser.addOrUpdateAuthMethod(providerName, profile);
        const authMethods = await currentUser.getAuthMethods();
        req.ctx.body = renderCallbackResponse({ authMethods }, origin);
        done(null, currentUser);
      } catch (error) {
        req.ctx.body = renderCallbackResponse({ error }, origin);
        done(error);
      }

      return;
    }

    try {
      const email = get(profile, 'emails[0].value');
      // get by the provider user id
      let user = await dbAdapter.getUserByProviderId(providerName, profile.id);

      // or try to get by email
      if (!user && email) {
        user = await dbAdapter.getUserByEmail(email);
      }

      // Try to add auth profile
      if (user) {
        await user.addOrUpdateAuthMethod(providerName, profile);
      }

      // if nothing was found, create a new account
      if (!user) {
        user = await createUserFromOauth(providerName, profile);
      }

      // Cache the access token for querying provider APIs right after registration/login.
      // For example, if we need to show a list of user's friends.
      await dbAdapter.updateUserAuthMethod(providerName, profile.id, { accessToken: token, profile });

      const authToken = jwt.sign({ userId: user.id }, config.secret);
      req.ctx.body = renderCallbackResponse({ authToken }, origin);
      done(null, user || false);
    } catch (error) {
      req.ctx.body = renderCallbackResponse({ error }, origin);
      done(error);
    }
  };
}

async function facebookAuthzCallback(req, token, tokenSecret, profile, done) {
  const origin = req.ctx.cookies.get('origin', { signed: true });
  const { user } = req.ctx.state;

  if (!user) {
    req.ctx.body = renderCallbackResponse({ error: 'Unauthorized' });
    return;
  }

  const authMethod = await user.getAuthMethod({
    providerName: 'facebook',
    providerId:   profile.id,
  });

  if (!authMethod) {
    req.ctx.body = renderCallbackResponse({ error: 'You are authenticated as a different facebook user' });
    return;
  }

  try {
    // Exchange the short-lived token for a long-lived one.
    const accessToken = await getLongLivedAccessToken({ accessToken: token });

    // cache accessToken
    await dbAdapter.updateUserAuthMethod('facebook', profile.id, { accessToken, profile });

    req.ctx.body = renderCallbackResponse({ accessToken }, origin);
  } catch (e) {
    // Respond with a short-lived token instead.
    req.ctx.body = renderCallbackResponse({ accessToken: token, error: e }, origin);
  }

  done(null, null);
}

export async function createUserFromOauth(providerName, profile) {
  const email = get(profile, 'emails[0].value');
  const firstName = get(profile, 'name.givenName');
  const lastName = get(profile, 'name.familyName');
  let { displayName } = profile;

  if (isEmpty(profile.id) && isEmpty(email)) {
    throw new Error('Either id or email must be present');
  }

  if (isEmpty(displayName)) {
    if (!isEmpty(firstName) && !isEmpty(lastName)) {
      displayName = `${firstName} ${lastName}`;
    } else if (!isEmpty(firstName)) {
      displayName = firstName;
    } else {
      displayName = profile.username;
    }
  }

  const username = await generateUsername(
    dbAdapter,
    {
      firstName,
      lastName,
      email,
      username: profile.username,
    }
  );

  const user = new User({
    username,
    email,
    screenName: displayName,
  });

  await user.create(false, true);
  await user.addOrUpdateAuthMethod(providerName, profile);

  return user;
}

export function getAuthParams(strategy) {
  const params = {};

  switch (strategy) {
    case 'facebook': {
      params.scope = ['email', 'public_profile', 'user_friends'];
      break;
    }
    case 'google': {
      params.scope = ['email'];
      break;
    }
    case 'github': {
      params.scope = ['user:email'];
      break;
    }
    default: throw new Error(`Unknown auth strategy '${strategy}'`);
  }

  return params;
}

export function getAuthzParams(strategy) {
  const params = {};

  switch (strategy) {
    case 'facebook': {
      params.scope = ['email', 'public_profile', 'user_friends'];
      params.authType = 'rerequest';
      break;
    }
    default: throw new Error(`Unknown auth strategy '${strategy}'`);
  }

  return params;
}
