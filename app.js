const express = require('express')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const {open} = require('sqlite')
const sqlite3 = require('sqlite3')
const path = require('path')

const databasePath = path.join(__dirname, 'twitterClone.db')

const app = express()

app.use(express.json())

let database = null

// Initialize database
const initializeDbAndServer = async () => {
  try {
    database = await open({
      filename: databasePath,
      driver: sqlite3.Database,
    })
    app.listen(3000, () =>
      console.log('Server running at http://localhost:3000/'),
    )
  } catch (error) {
    console.log(`DB Error: ${error.message}`)
    process.exit(1)
  }
}

initializeDbAndServer()

// JWT Authentication Middleware
function authenticateToken(request, response, next) {
  const authHeader = request.headers['authorization']
  const jwtToken = authHeader && authHeader.split(' ')[1]

  if (!jwtToken) {
    return response.status(401).send('Invalid JWT Token')
  }

  jwt.verify(jwtToken, 'MY_SECRET_TOKEN', (error, user) => {
    if (error) {
      return response.status(401).send('Invalid JWT Token')
    }

    request.user = user
    next()
  })
}

// Register API - POST /register/
app.post('/register/', async (request, response) => {
  const {username, password, name, gender} = request.body

  const selectUserQuery = `SELECT * FROM user WHERE username = '${username}'`
  const existingUser = await database.get(selectUserQuery)

  if (existingUser) {
    return response.status(400).send('User already exists')
  }

  if (password.length < 6) {
    return response.status(400).send('Password is too short')
  }

  const hashedPassword = await bcrypt.hash(password, 10)

  const insertUserQuery = `
    INSERT INTO user (username, password, name, gender)
    VALUES ('${username}', '${hashedPassword}', '${name}', '${gender}')
  `

  await database.run(insertUserQuery)

  response.status(200).send('User created successfully')
})

// Login API - POST /login/
app.post('/login/', async (request, response) => {
  const {username, password} = request.body

  const selectUserQuery = `SELECT * FROM user WHERE username = '${username}'`
  const user = await database.get(selectUserQuery)

  if (!user) {
    return response.status(400).send('Invalid user')
  }

  const isPasswordCorrect = await bcrypt.compare(password, user.password)

  if (!isPasswordCorrect) {
    return response.status(400).send('Invalid password')
  }

  const payload = {username: user.username}
  const jwtToken = jwt.sign(payload, 'MY_SECRET_TOKEN')

  response.status(200).send({jwtToken})
})

// Get the latest 4 tweets from people the user follows
app.get('/user/tweets/feed/', authenticateToken, async (request, response) => {
  const { username } = request.user;

  const user = await database.get(
    `SELECT user_id FROM user WHERE username = ?`,
    [username]
  );

  const tweetsQuery = `
    SELECT u.username, t.tweet, t.date_time
    FROM follower f
    JOIN tweet t ON f.following_user_id = t.user_id
    JOIN user u ON t.user_id = u.user_id
    WHERE f.follower_user_id = ?
    ORDER BY t.date_time DESC
    LIMIT 4
  `;
  const feed = await database.all(tweetsQuery, [user.user_id]);

  response.send(feed);
});


// Get the list of users the authenticated user is following
app.get('/user/following/', authenticateToken, async (request, response) => {
  const { username } = request.user;

  const user = await database.get(`SELECT user_id FROM user WHERE username = ?`, [username]);

  const query = `
    SELECT u.name
    FROM follower f
    JOIN user u ON f.following_user_id = u.user_id
    WHERE f.follower_user_id = ?
  `;
  const following = await database.all(query, [user.user_id]);

  response.send(following);
});


// Get the list of users who follow the authenticated user
app.get('/user/followers/', authenticateToken, async (request, response) => {
  const { username } = request.user;

  const user = await database.get(`SELECT user_id FROM user WHERE username = ?`, [username]);

  const query = `
    SELECT u.name
    FROM follower f
    JOIN user u ON f.follower_user_id = u.user_id
    WHERE f.following_user_id = ?
  `;
  const followers = await database.all(query, [user.user_id]);

  response.send(followers);
});


// Get all tweets of the authenticated user
app.get('/user/tweets/', authenticateToken, async (request, response) => {
  const { username } = request.user;

  const user = await database.get(`SELECT user_id FROM user WHERE username = ?`, [username]);

  const tweetsQuery = `
    SELECT t.tweet, COUNT(DISTINCT l.like_id) AS likes,
           COUNT(DISTINCT r.reply_id) AS replies, t.date_time
    FROM tweet t
    LEFT JOIN like l ON t.tweet_id = l.tweet_id
    LEFT JOIN reply r ON t.tweet_id = r.tweet_id
    WHERE t.user_id = ?
    GROUP BY t.tweet_id
  `;
  const tweets = await database.all(tweetsQuery, [user.user_id]);

  response.send(tweets);
});


// Get a specific tweet by tweetId
app.get('/tweets/:tweetId/', authenticateToken, async (request, response) => {
  const {tweetId} = request.params
  const {username} = request.user

  const selectTweetQuery = `
    SELECT * FROM tweet WHERE tweet_id = ${tweetId} AND username = '${username}'
  `
  const tweet = await database.get(selectTweetQuery)

  if (!tweet) {
    return response.status(401).send('Invalid Request')
  }

  const tweetDetailsQuery = `
    SELECT 
      tweet,
      (SELECT COUNT(*) FROM like WHERE tweet_id = ${tweetId}) AS likes,
      (SELECT COUNT(*) FROM reply WHERE tweet_id = ${tweetId}) AS replies,
      date_time 
    FROM tweet 
    WHERE tweet_id = ${tweetId}
  `
  const tweetDetails = await database.get(tweetDetailsQuery)
  response.send(tweetDetails)
})

// Get users who liked a tweet
app.get(
  '/tweets/:tweetId/likes/',
  authenticateToken,
  async (request, response) => {
    const {tweetId} = request.params
    const {username} = request.user

    const userQuery = `SELECT user_id FROM user WHERE username = ?`
    const user = await database.get(userQuery, [username])

    const accessCheckQuery = `
    SELECT * FROM follower
    INNER JOIN tweet ON follower.following_user_id = tweet.user_id
    WHERE tweet.tweet_id = ? AND follower.follower_user_id = ?
  `
    const access = await database.get(accessCheckQuery, [tweetId, user.user_id])

    if (!access) {
      return response.status(401).send('Invalid Request')
    }

    const likesQuery = `
    SELECT user.username
    FROM like 
    JOIN user ON like.user_id = user.user_id 
    WHERE like.tweet_id = ?
  `
    const likedUsers = await database.all(likesQuery, [tweetId])
    response.send({likes: likedUsers.map(user => user.username)})
  },
)

// Get replies of a tweet
app.get(
  '/tweets/:tweetId/replies/',
  authenticateToken,
  async (request, response) => {
    const {tweetId} = request.params
    const {username} = request.user

    const userQuery = `SELECT user_id FROM user WHERE username = ?`
    const user = await database.get(userQuery, [username])

    const accessCheckQuery = `
    SELECT * FROM follower
    INNER JOIN tweet ON follower.following_user_id = tweet.user_id
    WHERE tweet.tweet_id = ? AND follower.follower_user_id = ?
  `
    const access = await database.get(accessCheckQuery, [tweetId, user.user_id])

    if (!access) {
      return response.status(401).send('Invalid Request')
    }

    const repliesQuery = `
    SELECT user.name, reply.reply
    FROM reply
    JOIN user ON reply.user_id = user.user_id
    WHERE reply.tweet_id = ?
  `
    const replies = await database.all(repliesQuery, [tweetId])
    response.send({replies})
  },
)

// Create a new tweet
app.post('/user/tweets/', authenticateToken, async (request, response) => {
  const {tweet} = request.body
  const {username} = request.user

  const userQuery = `SELECT user_id FROM user WHERE username = ?`
  const user = await database.get(userQuery, [username])

  const postTweetQuery = `
    INSERT INTO tweet (tweet, user_id, date_time)
    VALUES (?, ?, datetime('now'))
  `
  await database.run(postTweetQuery, [tweet, user.user_id])
  response.send('Created a Tweet')
})

// Delete a tweet
app.delete(
  '/tweets/:tweetId/',
  authenticateToken,
  async (request, response) => {
    const {tweetId} = request.params
    const {username} = request.user

    const userQuery = `SELECT user_id FROM user WHERE username = ?`
    const user = await database.get(userQuery, [username])

    const tweetQuery = `SELECT * FROM tweet WHERE tweet_id = ? AND user_id = ?`
    const tweet = await database.get(tweetQuery, [tweetId, user.user_id])

    if (!tweet) {
      return response.status(401).send('Invalid Request')
    }

    const deleteQuery = `DELETE FROM tweet WHERE tweet_id = ?`
    await database.run(deleteQuery, [tweetId])
    response.send('Tweet Removed')
  },
)

module.exports = app
