import { InjectQueue } from '@nestjs/bull'
import {
    CACHE_MANAGER,
    forwardRef,
    Inject,
    Injectable,
    InternalServerErrorException,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Queue } from 'bull'
import { Cache } from 'cache-manager'
import { Brackets, In, Repository, SelectQueryBuilder } from 'typeorm'

import { GameToMusic, GameToMusicType } from '../../games/entity/game-to-music.entity'
import { Game } from '../../games/entity/game.entity'
import { Music } from '../../games/entity/music.entity'
import { shuffle } from '../../utils/utils'
import { LobbyMusic } from '../entities/lobby-music.entity'
import { LobbyUser, LobbyUserRole } from '../entities/lobby-user.entity'
import { Lobby, LobbyDifficulties, LobbyStatuses } from '../entities/lobby.entity'
import { LobbyGateway } from '../lobby.gateway'
import { LobbyService } from './lobby.service'

@Injectable()
export class LobbyMusicLoaderService {
    contributeMissingData: boolean
    lobby: Lobby

    constructor(
        @InjectRepository(Lobby)
        private lobbyRepository: Repository<Lobby>,
        @InjectRepository(Game)
        private gameRepository: Repository<Game>,
        @InjectRepository(Music)
        private musicRepository: Repository<Music>,
        @InjectRepository(LobbyMusic)
        private lobbyMusicRepository: Repository<LobbyMusic>,
        @InjectRepository(LobbyUser)
        private lobbyUserRepository: Repository<LobbyUser>,
        @InjectRepository(GameToMusic)
        private gameToMusicRepository: Repository<GameToMusic>,
        @Inject(forwardRef(() => LobbyGateway))
        private lobbyGateway: LobbyGateway,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        @InjectQueue('lobby')
        private lobbyQueue: Queue,
        @Inject(forwardRef(() => LobbyService))
        private lobbyService: LobbyService,
    ) {}
    async loadMusics(lobby: Lobby): Promise<void> {
        this.lobby = lobby
        const players = await this.lobbyUserRepository.find({
            relations: {
                user: true,
            },
            where: {
                lobby: {
                    id: this.lobby.id,
                },
                role: In([LobbyUserRole.Player, LobbyUserRole.Host]),
            },
        })

        if (players === undefined || players.length === 0) {
            this.lobby = this.lobbyRepository.create({
                ...this.lobby,
                status: LobbyStatuses.Waiting,
            })
            await this.lobbyRepository.save(this.lobby)
            this.lobbyGateway.sendUpdateToRoom(this.lobby)
            throw new InternalServerErrorException()
        }

        let userIds: number[] = []
        let userIdsRandom: Array<number[] | undefined> = []
        players.forEach((player) => {
            userIds = [...userIds, player.user.id]
            userIdsRandom = [
                ...userIdsRandom,
                ...Array<number[]>(Math.floor(this.lobby.musicNumber / players.length)).fill([
                    player.user.id,
                ]),
            ]
        })
        if (userIdsRandom.length < this.lobby.musicNumber) {
            userIdsRandom = [
                ...userIdsRandom,
                ...Array(this.lobby.musicNumber - userIdsRandom.length).fill([
                    userIds[Math.floor(Math.random() * userIds.length)],
                ]),
            ]
        }
        userIdsRandom = shuffle(userIdsRandom)

        let gameIds: number[] = []
        let blackListGameIds: number[] = []
        let lobbyMusics: LobbyMusic[] = []
        let position = 0

        const gameToMusicAccuracyRatio = await this.lobbyService.getMusicAccuracyRatio(this.lobby)

        while (userIdsRandom.some((userId) => userId !== undefined)) {
            let loadedMusic = 0
            for (const userId of userIdsRandom) {
                if (userId === undefined) {
                    continue
                }
                this.contributeMissingData = this.lobby.allowContributeToMissingData
                    ? Math.random() > gameToMusicAccuracyRatio
                    : false
                const i = userIdsRandom.indexOf(userId)
                const gameQueryBuilder = this.gameRepository
                    .createQueryBuilder('game')
                    .select('game.id')
                    .innerJoin('game.musics', 'gameToMusic')
                    .innerJoin('gameToMusic.music', 'music')
                    .innerJoin('game.users', 'user')
                    .andWhere('game.enabled = 1')
                    .andWhere('user.id in (:userIds)', { userIds: userId })
                    .andWhere('music.duration >= :guessTime')
                    .setParameter('guessTime', this.lobby.guessTime)
                    .groupBy('game.id')
                    .orderBy('RAND()')

                if (!this.lobby.allowDuplicates && gameIds.length > 0) {
                    gameQueryBuilder.andWhere('game.id not in (:ids)', { ids: gameIds })
                }
                if (blackListGameIds.length > 0) {
                    gameQueryBuilder.andWhere('game.id not in (:blackListIds)', {
                        blackListIds: blackListGameIds,
                    })
                }
                const game = await this.getGameOrMusic(gameQueryBuilder)

                if (game !== null) {
                    // TODO maybe remove leftJoinAndSelect and make separate queries to prevent a too long query
                    const qb = this.gameToMusicRepository
                        .createQueryBuilder('gameToMusic')
                        .leftJoinAndSelect('gameToMusic.music', 'music')
                        .leftJoinAndSelect('music.file', 'file')
                        .leftJoinAndSelect('gameToMusic.game', 'game')
                        .leftJoinAndSelect('gameToMusic.derivedGameToMusics', 'derivedGameToMusics')
                        .leftJoinAndSelect('derivedGameToMusics.game', 'derivedGames')
                        .leftJoinAndSelect('gameToMusic.originalGameToMusic', 'originalGameToMusic')
                        .leftJoinAndSelect('originalGameToMusic.game', 'originalGame')
                        .leftJoinAndSelect(
                            'originalGameToMusic.derivedGameToMusics',
                            'originalDerivedGameToMusics',
                        )
                        .leftJoinAndSelect(
                            'originalDerivedGameToMusics.game',
                            'originalDerivedGames',
                        )
                        .andWhere('gameToMusic.game = :game')
                        .andWhere('music.duration >= :guessTime')
                        .setParameter('game', game.id)
                        .setParameter('guessTime', lobby.guessTime)
                        .orderBy('RAND()')

                    if (lobbyMusics.length > 0) {
                        qb.andWhere('gameToMusic.id NOT IN (:musicIds)', {
                            musicIds: lobbyMusics.map((lobbyMusic) => lobbyMusic.gameToMusic.id),
                        })
                    }

                    const gameToMusic = await this.getGameOrMusic(qb)

                    if (!gameToMusic) {
                        blackListGameIds = [...blackListGameIds, game.id]
                        continue
                    }
                    gameIds = [...gameIds, game.id]

                    position += 1
                    const music = gameToMusic.music
                    const lobbyMusicDuration = lobby.playMusicOnAnswerReveal
                        ? lobby.guessTime + 10
                        : lobby.guessTime
                    const endAt =
                        lobbyMusicDuration > music.duration
                            ? music.duration
                            : this.getRandomFloat(lobbyMusicDuration, music.duration, 4)
                    const startAt =
                        lobbyMusicDuration > music.duration ? 0 : endAt - lobbyMusicDuration
                    let expectedAnswers: Game[] = []
                    if (gameToMusic.type === GameToMusicType.Original) {
                        expectedAnswers = [gameToMusic.game]
                        if (gameToMusic.derivedGameToMusics) {
                            expectedAnswers = [
                                ...expectedAnswers,
                                ...gameToMusic.derivedGameToMusics.map(
                                    (derivedGameMusic) => derivedGameMusic.game,
                                ),
                            ]
                        }
                    } else {
                        const originalGameToMusic = gameToMusic.originalGameToMusic
                        if (originalGameToMusic !== null) {
                            expectedAnswers = [originalGameToMusic.game]
                            if (originalGameToMusic.derivedGameToMusics) {
                                expectedAnswers = [
                                    ...expectedAnswers,
                                    ...originalGameToMusic.derivedGameToMusics.map(
                                        (derivedGameMusic) => derivedGameMusic.game,
                                    ),
                                ]
                            }
                        }
                    }
                    const hintModeGames = await this.getHintModeGames(gameToMusic, userIds)

                    lobbyMusics = [
                        ...lobbyMusics,
                        this.lobbyMusicRepository.create({
                            lobby,
                            gameToMusic,
                            position,
                            startAt,
                            endAt,
                            expectedAnswers,
                            hintModeGames,
                            contributeToMissingData: [
                                LobbyDifficulties.Easy,
                                LobbyDifficulties.Medium,
                                LobbyDifficulties.Hard,
                            ].every((value) => {
                                return lobby.difficulty.includes(value)
                            })
                                ? false
                                : this.contributeMissingData,
                        }),
                    ]
                    userIdsRandom.splice(i, 1, undefined)
                    await this.gameToMusicRepository.save({
                        ...gameToMusic,
                        playNumber: gameToMusic.playNumber + 1,
                    })
                    loadedMusic += 1
                    this.lobbyGateway.sendLobbyLoadProgress(
                        lobby,
                        Math.round((loadedMusic / lobby.musicNumber) * 100),
                    )
                } else {
                    if (userId.length === userIds.length) {
                        userIdsRandom.splice(i, 1, undefined)
                        continue
                    }
                    userIdsRandom = userIdsRandom.map((v) => {
                        if (Array.isArray(v) && v === userId) {
                            const userIdsFiltered = userIds.filter((uid) => !v?.includes(uid))
                            const random =
                                userIdsFiltered[Math.floor(Math.random() * userIdsFiltered.length)]
                            if (random) {
                                return [...v, random]
                            }
                        }
                        return v
                    })
                }
            }
        }

        if (lobbyMusics.length === 0) {
            lobby = this.lobbyRepository.create({ ...lobby, status: LobbyStatuses.Waiting })
            await this.lobbyRepository.save(lobby)
            this.lobbyGateway.sendUpdateToRoom(lobby)
            this.lobbyGateway.sendLobbyToast(lobby, 'No music were found!')

            return
        }
        lobby = this.lobbyRepository.create({ ...lobby, status: LobbyStatuses.Playing })
        await this.lobbyMusicRepository.save(lobbyMusics)
        await this.lobbyRepository.save(lobby)
        await this.lobbyQueue.add('bufferMusic', lobby.code, {
            jobId: `lobby${lobby.code}bufferMusic1`,
        })
    }

    private async getGameOrMusic<T extends Game | GameToMusic>(
        baseQueryBuilder: SelectQueryBuilder<T>,
    ): Promise<T | null> {
        let gameOrGameMusic: T | null
        const qbGuessAccuracyIsNull = baseQueryBuilder.clone()
        qbGuessAccuracyIsNull.andWhere('gameToMusic.guessAccuracy IS NULL')

        const qbGuessAccuracyReflectsLobbyDifficulty = baseQueryBuilder.clone()
        qbGuessAccuracyReflectsLobbyDifficulty.andWhere(
            new Brackets((difficultyQb) => {
                if (this.lobby.difficulty.includes(LobbyDifficulties.Easy))
                    difficultyQb.orWhere('gameToMusic.guessAccuracy > 0.66')
                if (this.lobby.difficulty.includes(LobbyDifficulties.Medium))
                    difficultyQb.orWhere('gameToMusic.guessAccuracy BETWEEN 0.33 AND 0.66')
                if (this.lobby.difficulty.includes(LobbyDifficulties.Hard))
                    difficultyQb.orWhere('gameToMusic.guessAccuracy < 0.33')
            }),
        )

        if (this.contributeMissingData) {
            gameOrGameMusic = await qbGuessAccuracyIsNull.getOne()

            if (!gameOrGameMusic) {
                if (
                    [
                        LobbyDifficulties.Easy,
                        LobbyDifficulties.Medium,
                        LobbyDifficulties.Hard,
                    ].every((value) => {
                        return this.lobby.difficulty.includes(value)
                    })
                ) {
                    gameOrGameMusic = await baseQueryBuilder.getOne()
                } else {
                    gameOrGameMusic = await qbGuessAccuracyReflectsLobbyDifficulty.getOne()
                    if (!gameOrGameMusic) {
                        gameOrGameMusic = await baseQueryBuilder.getOne()
                    }
                }
            }
        } else {
            if (
                [LobbyDifficulties.Easy, LobbyDifficulties.Medium, LobbyDifficulties.Hard].every(
                    (value) => {
                        return this.lobby.difficulty.includes(value)
                    },
                )
            ) {
                gameOrGameMusic = await baseQueryBuilder.getOne()
            } else {
                gameOrGameMusic = await qbGuessAccuracyReflectsLobbyDifficulty.getOne()
                if (this.lobby.allowContributeToMissingData && !gameOrGameMusic) {
                    this.contributeMissingData = true
                    gameOrGameMusic = await qbGuessAccuracyIsNull.getOne()
                    if (!gameOrGameMusic) {
                        gameOrGameMusic = await baseQueryBuilder.getOne()
                    }
                }
            }
        }
        return gameOrGameMusic
    }

    private async getHintModeGames(gameToMusic: GameToMusic, userIds: number[]): Promise<Game[]> {
        let hintModeGames: Game[] = [gameToMusic.game]
        let excludedGamesIds = [gameToMusic.game.id]
        if (gameToMusic.type === GameToMusicType.Original) {
            if (gameToMusic.derivedGameToMusics) {
                excludedGamesIds = [
                    ...excludedGamesIds,
                    ...gameToMusic.derivedGameToMusics.map(
                        (derivedGameMusic) => derivedGameMusic.game.id,
                    ),
                ]
            }
        } else {
            const originalGameToMusic = gameToMusic.originalGameToMusic
            if (originalGameToMusic !== null) {
                if (originalGameToMusic.derivedGameToMusics) {
                    excludedGamesIds = [
                        ...excludedGamesIds,
                        ...originalGameToMusic.derivedGameToMusics.map(
                            (derivedGameMusic) => derivedGameMusic.game.id,
                        ),
                    ]
                }
            }
        }
        const similarPlayedGamesWithMusics = await this.gameRepository
            .createQueryBuilder('game')
            .select('game.id')
            .innerJoin('game.musics', 'gameToMusic')
            .innerJoin('game.users', 'user')
            .innerJoin('game.isSimilarTo', 'similarGame')
            .andWhere('similarGame.id = :id', { id: gameToMusic.game.id })
            .andWhere('game.enabled = 1')
            .andWhere('user.id in (:userIds)', { userIds })
            .andWhere('game.id not in (:ids)', { ids: excludedGamesIds })
            .groupBy('game.id')
            .limit(3)
            .orderBy('RAND()')
            .getMany()
        hintModeGames = [...hintModeGames, ...similarPlayedGamesWithMusics]
        if (hintModeGames.length === 4) return hintModeGames
        excludedGamesIds = [...excludedGamesIds, ...hintModeGames.map((game) => game.id)]
        const playedGamesWithMusics = await this.gameRepository
            .createQueryBuilder('game')
            .select('game.id')
            .innerJoin('game.musics', 'gameToMusic')
            .innerJoin('game.users', 'user')
            .andWhere('game.enabled = 1')
            .andWhere('user.id in (:userIds)', { userIds })
            .andWhere('game.id not in (:ids)', { ids: excludedGamesIds })
            .groupBy('game.id')
            .limit(4 - hintModeGames.length)
            .orderBy('RAND()')
            .getMany()
        hintModeGames = [...hintModeGames, ...playedGamesWithMusics]
        if (hintModeGames.length === 4) return hintModeGames
        excludedGamesIds = [...excludedGamesIds, ...hintModeGames.map((game) => game.id)]
        const similarPlayedGames = await this.gameRepository
            .createQueryBuilder('game')
            .select('game.id')
            .innerJoin('game.users', 'user')
            .innerJoin('game.isSimilarTo', 'similarGame')
            .andWhere('similarGame.id = :id', { id: gameToMusic.game.id })
            .andWhere('game.enabled = 1')
            .andWhere('user.id in (:userIds)', { userIds })
            .andWhere('game.id not in (:ids)', { ids: excludedGamesIds })
            .groupBy('game.id')
            .limit(4 - hintModeGames.length)
            .orderBy('RAND()')
            .getMany()
        hintModeGames = [...hintModeGames, ...similarPlayedGames]
        if (hintModeGames.length === 4) return hintModeGames
        excludedGamesIds = [...excludedGamesIds, ...hintModeGames.map((game) => game.id)]
        const playedGames = await this.gameRepository
            .createQueryBuilder('game')
            .select('game.id')
            .innerJoin('game.users', 'user')
            .andWhere('game.enabled = 1')
            .andWhere('user.id in (:userIds)', { userIds })
            .andWhere('game.id not in (:ids)', { ids: excludedGamesIds })
            .groupBy('game.id')
            .limit(4 - hintModeGames.length)
            .orderBy('RAND()')
            .getMany()
        hintModeGames = [...hintModeGames, ...playedGames]
        if (hintModeGames.length === 4) return hintModeGames
        excludedGamesIds = [...excludedGamesIds, ...hintModeGames.map((game) => game.id)]
        const gamesWithMusics = await this.gameRepository
            .createQueryBuilder('game')
            .select('game.id')
            .innerJoin('game.musics', 'gameToMusic')
            .andWhere('game.id not in (:ids)', { ids: excludedGamesIds })
            .groupBy('game.id')
            .limit(4 - hintModeGames.length)
            .orderBy('RAND()')
            .getMany()
        hintModeGames = [...hintModeGames, ...gamesWithMusics]
        if (hintModeGames.length === 4) return hintModeGames
        throw new InternalServerErrorException()
    }

    getRandomFloat(min: number, max: number, decimals: number): number {
        const str = (Math.random() * (max - min) + min).toFixed(decimals)

        return parseFloat(str)
    }
}