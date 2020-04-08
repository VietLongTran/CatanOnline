const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')
const {doNegativePlayerResource,doStealFromAnotherPerson,doDiceRoll,findRobbedByRobber,passTurn,Game,doBuyDevelopmentCard,doUseDevelopmentCard,doMoveRobberTo,doBuildSettlement,doBuildCity,
    doBuildRoad,findWinCondition,doChangePlayerResource,doUseMonopolyCard,findTotalResources,doBuildSettlementInitial,doBuildRoadInitial} = require('./Model/model')
const _ = require('lodash')

module.exports = (io)=>{

    const socketMap = new Map()
    const timerMap = new Map()
    const turnSpecificInfo = new Map()
    const tradingThreads = new Map()

    io.on('connect',async (socket)=>{

        const emit = (message,arg)=>io.to(socket.roomCode).emit(message,arg)
        const emitWithoutSelf = (message,arg)=>socket.to(socket.roomCode).emit(message,arg)

        const resetTurnSpecificInfo = ()=>{
            turnSpecificInfo.set(socket.roomCode,{
                boughtDevelopmentCard:false,
                usedDevelopmentCard:false,
                state:'normal',
                //if the state is waiting, every other event will be disabled except for the 
                //event that it is waiting for
                waitingFor:[],
                waitingMessage:'',
                turn:-1,
                phase:-1,
                waitingFunction:()=>{}
                //phase 1 is before dice action
                //phase 2 is after dice action
                //phase 3 is special action in the case of a robber
            })
        }
        const socketError = (error)=>{
            const {message} = error
            console.log(error)
            socket.emit('Error',{error})
        }
        const asyncSocketWrap = (func)=>async (...args)=>{
            try{return await func(...args);} catch({message}){return socketError(message);}
        }

        const socketFunctionFactory = (func)=>asyncSocketWrap(async(...args)=>{
            return await func(...args)
        })

        //Controller
        const startTurnTimer = ()=>{
            cancelTurnTimer()
            timerMap.set(socket.roomCode,setTimeout(()=>{
                socket.emit("Start turn timer")
                socket.turnTimer = setTimeout(()=>{
                    passTurnController()
                })
            },30000))
        }
        
        const cancelTurnTimer = ()=>{
            socket.emit("Cancel turn timer")
            clearTimeout(timerMap.get(socket.roomCode))
            timerMap.set(socket.roomCode,null)
        }

        const buildInitialStructure = async ()=>{
            for(let i = 0;i<socket.game.players.length;i++){
                await changeToWaitingState('Build Settlement Initial',[i])
                await changeToWaitingState('Build Road Initial',[i])
            }
            for(let i = socket.game.players.length-1;i>=0;i--){
                await changeToWaitingState('Build Settlement Initial',[i])
                await changeToWaitingState('Build Road Initial',[i])
            }
        }

        const startGame = socketFunctionFactory(async ()=>{
            //Still have to check in game because multiple messages may be sending at the same time
            if(!socket.game.inGame){
                socket.game.inGame = true
                await buildInitialStructure()
                await socket.game.save()
                io.to(socket.game.roomCode).emit("Game starting")
                actionNeeded()
            }
        })

        const passTurnController = async ()=>{
            const win = await findWinCondition(socket.game)
            if(typeof win === 'number') return endGame(win)
            else if(win.armyChange || win.roadChange) emit('Change in extra condition',win)
            actionNeeded()
        }

        const endGame = (winner)=>{
            emit({winner})
        }

        const actionNeeded = async ()=>{
            cancelTurnTimer()
            resetTurnSpecificInfo()
            //Check if someone had win the game after every turn
            setTurnSpecificInfo('phase',1)
            await passTurn(socket.game)
            emit('Action Needed',{turn:socket.game.onTurn})
        }

        const moveRobber = async ()=>{
            const position = await awaitAction('Choose Knight location')
            const robbable = await doMoveRobberTo(socket.game,position)
            if(!robbable) throw Error('Position Invalid')
            emitWithoutSelf('Move Knight',{position})
            const willBeRob = await awaitAction('Choose who to steal from')
            const resource = await doStealFromAnotherPerson(socket.game,socket.userid,willBeRob)
            emit('Resource Stolen',{resource})
        }  


        const changeToWaitingState = (message,players)=>{
            setTurnSpecificInfo('state','waiting')
            setTurnSpecificInfo('waitingMessage',message)
            setTurnSpecificInfo('waitingFor',players)
            players.forEach((e)=>{
                io.to(socketMap.get(socket.roomCode)[e]).emit(`Waiting for ${message}`)
            })
            return new Promise(r=>setTurnSpecificInfo('waitingFunction',r))
        }

        const changeToNormalState = ()=>{
            setTurnSpecificInfo('state','normal')
            setTurnSpecificInfo('waitingMessage',"")
            setTurnSpecificInfo('waitingFor',[])
            const func = getTurnSpecificInfo('waitingFunction')
            func()
            setTurnSpecificInfo('waitingFunction',()=>{})
        }

        const setTurnSpecificInfo = (property,value)=>{
            const newObject = {...turnSpecificInfo.get(socket.roomCode)}
            newObject[property] = value
            turnSpecificInfo.set(socket.roomCode,newObject)
        }

        const getTurnSpecificInfo = (property)=>turnSpecificInfo.get(socket.roomCode)[property]

        const addNewTradingThread = (player1,player2)=>{
            const characters='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
            let randomCode
            for(let i = 0;i<7;i++) randomCode+=characters[_.random(characters.length-1)]
            if(!tradingThreads.has(socket.roomCode)) tradingThreads.set(socket.roomCode,new Map())
            tradingThreads.get(socket.roomCode).set(randomCode,[player1,player2])
            return randomCode
        }

        const getTradersOfThread = (code)=>tradingThreads.get(socket.roomCode).get(code)

        const closeTradingThread = (randomCode)=>{
            tradingThreads.get(socket.roomCode).set(randomCode,undefined)
        }

        const canTradeWithCode = (code)=>{
            if(!tradingThreads.get(socket.roomCode).has(code)) return false
            if(!tradingThreads.get(socket.roomCode).get(code).includes(socket.userid)) return false
            return true
        }

        const attachTradingAction = (message,func)=>socket.on(message,socketFunctionFactory(async ({resources,code})=>{
            if(canTradeWithCode(code)) return await func({resources,code})
        }))

        const actionFunctionFactory = (func,message)=>socketFunctionFactory(async (data)=>{
            const phase = getTurnSpecificInfo('phase')
            if(getTurnSpecificInfo('state') !== 'normal') throw new Error("You cannot do that action at this time")
            if((phase === 1||phase === 2) && socket.userid === socket.game.onTurn){
                try{await func(data);emit(message,data)}catch(e){throw new Error(e.message)}
            }
            else throw new Error('Not your turn')
        })

        const phase1ActionFunctionFactory = (func,message)=>actionFunctionFactory(async(data)=>{
            const phase=getTurnSpecificInfo('phase')
            if(phase===1) return await func(data)
            throw new Error('This action can not be done at this time')
        },message)

        const phase2ActionFunctionFactory = (func,message)=>actionFunctionFactory(async(data)=>{
            const phase = getTurnSpecificInfo('phase')
            if(phase===2) return await func(data)
            throw new Error('This action can not be done at this time')
        },message)

        const waitingFunctionFactory = (func,message)=>socketFunctionFactory(async (data)=>{
            if(getTurnSpecificInfo('state')=== 'normal') throw new Error('You cannot do this at this time')
            const arr = getTurnSpecificInfo('waitingFor')
            if(!arr.includes(socket.userid)) throw new Error('You cannot do this at this time')
            if(getTurnSpecificInfo('waitingMessage') !== message) throw new Error('You cannot do this at this time')
            try{
                await func(data)
                const newArray = arr.filter(e=>e!==socket.userid)
                if(newArray.length === 0){
                    changeToNormalState()
                }
            }
            catch(e){
                throw new Error(e.message)
            }
        })

        const attachActionToSocket = (message,func)=>socket.on(message,actionFunctionFactory(func,message))
        const attachPhase1ActionToSocket = (message,func)=>socket.on(message,phase1ActionFunctionFactory(func,message))
        const attachPhase2ActionToSocket = (message,func)=>socket.on(message,phase2ActionFunctionFactory(func,message))
        const attachWaitingActionToSocket = (message,func)=>socket.on(message,waitingFunctionFactory(func,message))

        const actionAwaitable = ['Choose Monopoly resources','Choose Plenty resources','Choose Knight location','Choose who to steal from','Choose road location','Choose settlement location','Choose city location']
        const actionAwaitableFunction = actionAwaitable.map(e=>[])
        actionAwaitable.forEach((e,i)=>socket.on(e,(data)=>actionAwaitableFunction[i].forEach(f=>f(data))))
        const awaitAction = async (message)=>new Promise((resolve,reject)=>{
            let done = false
            actionAwaitableFunction[actionAwaitable.indexOf(message)].push((data)=>{done = true;resolve(data)})
            setTimeout(()=>{
                if(!done) reject()
            },30000)
        })

        //Intiating the socket for use
        const {roomCode,userid} = jwt.verify(socket.handshake.query.token,process.env.SECRET_KEY)
        if(userid === undefined || !roomCode){
            socketError("Credential is invalid")
            socket.disconnect()
            return;
        }
        socket.roomCode = roomCode
        socket.userid = userid
        socket.game = await Game.findOne({roomCode})
        socket.user = socket.game.players[socket.userid]
        socket.username = socket.game.playerUsernames[socket.userid]
        socket.join(socket.roomCode)
        emitWithoutSelf('New player',{username:socket.username})
        const gameData = socket.game.toObject()
        socket.emit("Game data",{gameData})
        if(!socketMap.has(socket.roomCode)){
            socketMap.set(socket.roomCode,[])
        }
        socketMap.set(socket.roomCode,[...socketMap.get(socket.roomCode),socket.id])
        if(socket.game.players.length === 4) startGame(socket.game)
        //Initiation ended

        //Events

        socket.on("Start game",asyncSocketWrap(()=>{if(socket.userid ===0) startGame(socket.game); }))

        attachPhase2ActionToSocket('Pass Turn',()=>{
            cancelTurnTimer()
            passTurnController()
        })

        //TODO: WORK ON THE TRADING SYSTEM
        attachPhase1ActionToSocket('Roll Dice',async ()=>{
            const result = _.random(10) + 2
            if(result === 7){
                let robbed = await findRobbedByRobber(socket.game)
                if(robbed.length !== 0){
                    await changeToWaitingState('Discard Cards',robbed)
                    emit('Dice result',{dice:result})
                    await moveRobber()
                }
            }
            else{
                await doDiceRoll(socket.game,result)
                emit('Dice Result',{dice:result})
            }
            setTurnSpecificInfo('phase',2)
        })

        attachWaitingActionToSocket('Discard Cards',async ({resource})=>{
            let total = 0
            for(let kind of resource){
                total+=socket.user[kind]
            }
            if(total === Math.ceil((await findTotalResources(socket.game,socket.userid)) / 2)){
                await doChangePlayerResource(resource)
                await doNegativePlayerResource(socket.game,socket.userid,resource)
            }
            else throw Error('Not the right amount of resources')
        })

        attachActionToSocket("Trade Initiation",actionFunctionFactory(({players,resources})=>{
            const codes = players.map(e=>addNewTradingThread(socket.userid,e))
            emitWithoutSelf("Trade Initiation",{players,resources,codes})
        }))

        attachWaitingActionToSocket('Build Settlement Initial',async ({position})=>{
            const tf = await doBuildSettlementInitial(socket.game,socket.userid,position)
            if(!tf) throw Error('Invalid position')
            else emitWithoutSelf('Build Settlement Initial',{position})
        })

        attachWaitingActionToSocket('Build Road Initial',async ({settlementPosition,roadPosition})=>{
            await socket.game.save()
            const tf1 = await doBuildRoadInitial(socket.game,socket.userid,settlementPosition,roadPosition)
            if(!tf1) throw Error('Invalid road')
            else emitWithoutSelf('Build Road Initial',{roadPosition})
        })

        attachTradingAction('Trade Acceptance',async ({code,resources})=>{
            const otherPlayer = getTradersOfThread(code).filter(e=>e!==socket.userid)[0]
            const [resource1,resource2] = resources
            await doChangePlayerResource(socket.game,socket.userid,resource2)
            await doChangePlayerResource(socket.game,otherPlayer,resource1)
            await doNegativePlayerResource(socket.game,socket.userid,resource1)
            await doNegativePlayerResource(socket.game,otherPlayer,resource2)
            emitWithoutSelf("Trade Acceptance",players,resource)
            closeTradingThread(code)
        })

        attachTradingAction('Trade Refuse',({code})=>{
            emitWithoutSelf('Trade Refuse',{code})
            closeTradingThread(code)
        })

        attachTradingAction('Trade Response',({resources,code})=>{
            emitWithoutSelf('Trade Response',{resources,code})
        })
        
        attachActionToSocket('Trade with Bank',async ({resource})=>{
            const [give,take] = resource
            let eligibleResources = 0
            const negativeGive = {...give}
            for (let resource in give){
                let defaultRate = 4
                if(socket.user.randomTrade) defaultRate = 3
                if(socket.user[resource+"Trade"]) defaultRate = 2
                if(give[resource] % defaultRate !== 0) throw Error("Invalid Trade")
                else eligibleResources += give[resource]/defaultRate
                negativeGive[resource] = - negativeGive[resource]
            }
            let totalTake = 0
            for(let resource in take){
                totalTake += take[resource]
            }

            if(eligibleResources !== totalTake) throw Error("Invalid Trade")
            await doChangePlayerResource(socket.game,socket.userid,take)
            await doChangePlayerResource(socket.game,socket.userid,negativeGive)
        })

        const actionErrorMessage = "Do not have enough resources to complete that action"

        attachPhase2ActionToSocket('Buy development card',(async ()=>{
            if(getTurnSpecificInfo('boughtDevelopmentCard')) throw Error("You already bought a card")
            else setTurnSpecificInfo('boughtDevelopmentCard',true)
            const card = await doBuyDevelopmentCard(socket.game,socket.userid)
            if(!card) throw Error(actionErrorMessage)
            socket.emit("Your development card",{card})
        }))


        attachPhase2ActionToSocket("Build road",async ({position})=>{
            const road = await doBuildRoad(socket.game,socket.userid,position)
            console.log(road,'road')
            if(!road) throw Error(actionErrorMessage)
        })

        attachPhase2ActionToSocket('Build settlements',async ({position})=>{
            const settlement = await doBuildSettlement(socket.game,socket.userid,position)
            console.log(settlement,'settlement')
            if(!settlement) throw Error(actionErrorMessage)
        })

        attachPhase2ActionToSocket('Build city',async ({position})=>{
            const city = await doBuildCity(socket.game,socket.userid,position)
            console.log(city,'city')
            if(!city) throw Error(actionErrorMessage)
        })

        attachActionToSocket('Use development card',async (data)=>{
            if(getTurnSpecificInfo('phase') !== 2 && data.card !== 'Knight') throw Error("You cannot do this action at this time")
            const {card} = data
            if(getTurnSpecificInfo('usedDevelopmentCard')) return
            setTurnSpecificInfo('usedDevelopmentCard',true)
            const doYouHaveTheCard = await doUseDevelopmentCard(socket.game,socket.userid,card)
            if(!doYouHaveTheCard) throw Error("You do not have that card")
            switch(card){
                case 'Monopoly':
                    const r = data.resource
                    if(r !== 'Wheat' && r !== 'Brick' && r !== 'Sheep' && r !== 'Wood' && r !== 'Rock') return false
                    await doUseMonopolyCard(socket.game,socket.userid,r)
                    emitWithoutSelf("Monopoly resource chosen",{resource:r})
                    break;
                case "Knight":
                    moveRobber()
                    break
                case "Plenty":
                    const resource = await awaitAction('Choose Plenty resources')
                    let totalResource = 0
                    for(r of resource){
                        totalResource+=resource[r]
                    }
                    if(totalResource !== 2) throw Error("More than 2 resources")
                    for(r of resource){
                        socket.user[`${r.toLowerCase()}Amount`]+=resource[r]
                    }
                    game.save()
                    emitWithoutSelf("Plency card chosen",{resource})
                    break
                case "Road":
                    const {positions} = data
                    if(!positions) throw Error("Position invalid")
                    if(positions.length !== 2) throw Error("Not the right amount of roads")
                    const tf1 = await doBuildRoadInitial(socket.game,socket.userid,positions[0])
                    const tf2 = await doBuildRoadInitial(socket.game,socket.userid,positions[1])
                    if(!(tf1 && tf2)) throw Error("Positions invalid")
                    break
                default:
                    throw Error("That card does not exist/Cannot be played.")
            }
        })

        //For debugging purpose
        socket.on('Get info',()=>{
            console.log(socket)
        })

        socket.on('Cheat',async ()=>{
            await doChangePlayerResource(socket.game,socket.userid,{
                wheat:500,
                rock:500,
                wood:500,
                brick:500,
                sheep:500
            })
            socket.emit("Cheat Done",socket.user)
        })
    })
}